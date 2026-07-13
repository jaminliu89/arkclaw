import fs from "node:fs";
import os from "node:os";
import * as path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getNonEmptyString, resolveSessionId } from "./src/utils.js";
import { registerSkillSwitchCommand, registerBuaFocusCommand, executeBuaFocus, } from "./src/commands.js";
import { createSkillInjectionHook } from "./src/skill-injection-hook.js";
import { createLlmInputDiagHook, createLlmOutputDiagHook, resetImHandoffCycleForSession, } from "./src/llm-input-diag-hook.js";
import { registerCuaCommand, prepImHandoffScreenshotFromLatestRun, } from "./src/cua_commands.js";
import { markHandoffSource } from "./src/handoff-source.js";
import { createWechatHandoffRetryHook } from "./src/wechat-handoff-retry-hook.js";
import { createWechatHandoffDedupHook } from "./src/wechat-handoff-dedup-hook.js";
import { isSpikeEnabled, runSpikeP1Send } from "./src/spike-p1-sender.js";
import { detectConversationSource } from "./src/conversation-source.js";
import { logHookTiming } from "./src/hook-timing-log.js";
import { injectCuaOverrideIntoCommand } from "./src/cua-session-model.js";
// IM handoff 默认截图路径,跟 conversation-source.ts marker 对齐
// (BUA 路径下 LLM 自己跑 `bua screenshot + convert` 写到这里;CUA 路径下
// plugin 在 after_tool_call_cua hook 写到这里)。
const DEFAULT_HANDOFF_PATH = path.join(process.env.HOME || os.homedir(), ".openclaw/media/outbound/handoff.jpg");
import { scanSkillsFromDirectories } from "./src/skill-discovery.js";
import { getSessionActiveSkill, getStoredActiveSkill, setSessionActiveSkill, GLOBAL_CONTEXT_KEY, updateCachedSkills, } from "./src/session-state.js";
import { cleanToolCallsFromHistory } from "./src/history-cleaner.js";
import { triggerReprocess } from "./src/reprocess.js";
import { resolveWorkspaceDir } from "./src/workspace.js";
import { registerCuaRecordingCommand } from "./src/video-to-prompt/commands.js";
import { registerCuaRecordingGateway } from "./src/video-to-prompt/gateway.js";
import { startMaintenanceScheduler } from "./src/video-to-prompt/cleanup-scheduler.js";
import { startSkillIndexScheduler } from "./src/video-to-prompt/skill-index-scheduler.js";
import { rebuildCuaRecordingIndex } from "./src/video-to-prompt/recording-index.js";
import { readSkillsConfig } from "./src/video-to-prompt/helpers.js";
const BUA_HOOK_LOG_REL_PATH = ["extensions", "skill-switch", "bua-hook.log"];
const SESSION_FLAGS = new Set(["--session", "-s"]);
const MAX_LOG_FIELD_LEN = 400;
function isPromiseLike(value) {
    return (typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function");
}
function wrapHookWithTiming(api, hookName, handler) {
    return (event, ctx) => {
        const startTimestamp = Date.now();
        const logTiming = () => {
            logHookTiming(api, hookName, startTimestamp, Date.now());
        };
        try {
            const result = handler(event, ctx);
            if (isPromiseLike(result)) {
                return result.then((value) => {
                    logTiming();
                    return value;
                }, (error) => {
                    logTiming();
                    throw error;
                });
            }
            logTiming();
            return result;
        }
        catch (error) {
            logTiming();
            throw error;
        }
    };
}
function resolveToolName(event) {
    return getNonEmptyString(event?.toolName) ?? getNonEmptyString(event?.cmd);
}
function resolveCommandStringFromParams(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params)) {
        return null;
    }
    // OpenClaw shell tool typically uses params.command (string)
    const fromCommand = getNonEmptyString(params.command);
    if (fromCommand)
        return { key: "command", value: fromCommand };
    // Fallbacks for other runtimes / versions
    const fromCmd = getNonEmptyString(params.cmd);
    if (fromCmd)
        return { key: "cmd", value: fromCmd };
    return null;
}
function isBuaCommandString(command) {
    return /^bua(\s|$)/.test(command.trimStart());
}
function commandContainsBuaScreenshot(command) {
    return /\bbua\s+(?:(?:--session|-s)(?:\s+|=)\S+\s+)?screenshot\b/.test(command);
}
function isBuaScreenshotToolCall(event) {
    if (resolveToolName(event) !== "bua")
        return false;
    const params = event?.params;
    if (params == null || typeof params !== "object" || Array.isArray(params)) {
        return false;
    }
    const subcommand = getNonEmptyString(params.subcommand) ?? getNonEmptyString(params.command);
    return subcommand === "screenshot";
}
/**
 * Detect if a shell command invokes cua.sh. Main agent invokes it via
 * natural-language → `bash skills/computer-use/scripts/cua.sh run "..."`,
 * not via the /cua slash command. So after_tool_call hook is the only
 * place we can intercept cua completions.
 */
function isCuaCommandString(command) {
    return /cua\.sh(\s|$)/.test(command);
}
function isCuaRunCommandString(command) {
    return /cua\.sh\s+run(\s|$)/.test(command);
}
function resolveBuaToolName(event) {
    const direct = resolveToolName(event);
    if (direct && direct === "bua") {
        return "bua";
    }
    const cmd = resolveCommandStringFromParams(event?.params);
    if (cmd && isBuaCommandString(cmd.value)) {
        // Treat shell command invocation as a logical "bua" tool call
        return "bua";
    }
    return null;
}
function escapeShellArg(arg) {
    // Escape special shell characters to prevent command injection and syntax errors
    // Characters to escape: space, quotes, backslash, $, `, ;, &, |, *, ?, <, >, (, ), [, ], {, }, !, ~, #
    if (/[^A-Za-z0-9_+=-]/.test(arg)) {
        return "'" + arg.replace(/'/g, "'\\''") + "'";
    }
    return arg;
}
function injectSessionIntoBuaCommand(command, sessionId) {
    // Best-effort: do not re-inject if caller already provides it
    if (/\s(--session(\s|=|$)|-s(\s|=|$))/.test(command)) {
        return { command, injected: false };
    }
    const trimmed = command.trim();
    if (!isBuaCommandString(trimmed)) {
        return { command, injected: false };
    }
    const safeSession = escapeShellArg(sessionId);
    // Prefer global flag position: `bua --session <id> <subcommand> ...`
    const injectedCommand = trimmed.replace(/^bua(\s|$)/, `bua --session ${safeSession}$1`);
    return { command: injectedCommand, injected: true };
}
function resolveTraceId(value) {
    return (getNonEmptyString(value?.traceId) ??
        `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
}
function resolveBuaHookLogPath(api) {
    return path.join(api.runtime.state.resolveStateDir(), ...BUA_HOOK_LOG_REL_PATH);
}
function safeJsonStringify(obj, space) {
    // Handle circular references and special cases safely
    const seen = new WeakSet();
    return JSON.stringify(obj, (_key, value) => {
        if (typeof value === "object" && value !== null) {
            if (seen.has(value)) {
                return "[Circular Reference]";
            }
            seen.add(value);
        }
        // Handle other non-serializable values
        if (typeof value === "function") {
            return "[Function]";
        }
        if (typeof value === "symbol") {
            return value.toString();
        }
        if (value !== value) {
            // NaN
            return "NaN";
        }
        if (value === Infinity) {
            return "Infinity";
        }
        if (value === -Infinity) {
            return "-Infinity";
        }
        return value;
    }, space);
}
function truncateString(value, maxLen = MAX_LOG_FIELD_LEN) {
    const str = typeof value === "string" ? value : String(value ?? "");
    if (str.length <= maxLen)
        return str;
    return str.slice(0, maxLen) + "…";
}
function buildBuaBeforeLogSummary(event, paramsBefore, paramsAfter) {
    // Avoid logging full params to prevent sensitive data leakage.
    // Only keep high-signal, low-risk fields.
    const summary = {};
    const beforeCmd = resolveCommandStringFromParams(paramsBefore)?.value;
    const afterCmd = resolveCommandStringFromParams(paramsAfter)?.value;
    if (beforeCmd || afterCmd) {
        summary.commandBefore = beforeCmd ? truncateString(beforeCmd) : null;
        summary.commandAfter = afterCmd ? truncateString(afterCmd) : null;
    }
    if (resolveToolName(event) === "bua") {
        const beforeSub = getNonEmptyString(paramsBefore?.subcommand);
        const afterSub = getNonEmptyString(paramsAfter?.subcommand);
        if (beforeSub || afterSub) {
            summary.subcommandBefore = beforeSub;
            summary.subcommandAfter = afterSub;
        }
    }
    return summary;
}
function buildBuaAfterLogSummary(event) {
    // Avoid logging full stdout/stderr. Keep truncated preview.
    const stdout = typeof event?.stdout === "string" ? event.stdout : "";
    const stderr = typeof event?.stderr === "string" ? event.stderr : "";
    const result = event?.result ?? stdout;
    const error = event?.error ?? stderr;
    return {
        exitCode: typeof event?.exitCode === "number" ? event.exitCode : null,
        signal: getNonEmptyString(event?.signal),
        durationMs: typeof event?.durationMs === "number" ? event.durationMs : null,
        result: truncateString(result),
        error: truncateString(error),
    };
}
function getToolResultText(event) {
    const parts = [];
    for (const value of [
        event?.result,
        event?.stdout,
        event?.stderr,
        event?.error,
        event?.output,
    ]) {
        if (typeof value === "string") {
            parts.push(value);
        }
        else if (value != null) {
            parts.push(safeJsonStringify(value));
        }
    }
    return parts.join("\n");
}
function isCuaResultInterrupted(event) {
    const text = getToolResultText(event);
    return /interrupted|⏸️?\s*任务已暂停|needs_user|需要人工介入|需要用户手动操作/i.test(text);
}
function appendBuaHookLog(api, record) {
    try {
        const logPath = resolveBuaHookLogPath(api);
        fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o755 });
        fs.appendFileSync(logPath, `${safeJsonStringify(record)}\n`, "utf8");
    }
    catch (error) {
        api.logger.warn(`[skill-switch] failed to write bua hook log: ${String(error)}`);
    }
}
function hasSessionArg(args) {
    return args.some((arg) => SESSION_FLAGS.has(arg) ||
        arg.startsWith("--session=") ||
        arg.startsWith("-s="));
}
function createBeforeToolCallHook(api) {
    return (event, ctx) => {
        const sessionId = resolveSessionId(ctx, event);
        const cuaCmd = resolveCommandStringFromParams(event?.params);
        if (sessionId && cuaCmd && isCuaRunCommandString(cuaCmd.value)) {
            resetImHandoffCycleForSession(sessionId);
        }
        const toolName = resolveBuaToolName(event) ??
            (cuaCmd && isCuaCommandString(cuaCmd.value) ? "cua" : null);
        if (!toolName) {
            return;
        }
        const traceId = resolveTraceId(event);
        let injectedSession = false;
        let injectedCuaArgs = false;
        let cuaFallbackReason = cuaCmd ? "not_applicable" : "not_applicable";
        // OpenClaw framework format: event.params is a Record<string, unknown>
        // Important: create a COPY of params to avoid mutating the original event object
        // This prevents race conditions when multiple plugins modify the same event
        const originalParams = event?.params;
        const isFrameworkFormat = originalParams != null &&
            typeof originalParams === "object" &&
            !Array.isArray(originalParams);
        // Legacy format: event.args is a string[]
        const originalArgs = Array.isArray(event?.args)
            ? [...event.args]
            : null;
        const paramsBefore = isFrameworkFormat
            ? { ...originalParams }
            : originalArgs
                ? [...originalArgs]
                : null;
        // Create new params object instead of mutating the original
        let modifiedParams = null;
        let modifiedArgs = null;
        if (sessionId) {
            // Shell tool format: params.command contains the full CLI command
            if (isFrameworkFormat) {
                modifiedParams = { ...originalParams }; // Create shallow copy
                const cmd = resolveCommandStringFromParams(modifiedParams);
                if (cmd && isBuaCommandString(cmd.value)) {
                    // Shell command format: inject session into bua command string
                    const injected = injectSessionIntoBuaCommand(cmd.value, sessionId);
                    if (injected.injected) {
                        modifiedParams[cmd.key] = injected.command;
                        injectedSession = true;
                    }
                }
                else if (resolveToolName(event) === "bua") {
                    // Framework format: the tool itself is bua. Only inject if no session-like field exists.
                    const existing = resolveSessionId(modifiedParams);
                    if (!existing) {
                        modifiedParams.session = sessionId;
                        injectedSession = true;
                    }
                }
                const currentCommand = resolveCommandStringFromParams(modifiedParams);
                if (currentCommand && isCuaRunCommandString(currentCommand.value)) {
                    const source = detectConversationSource({
                        sessionKey: sessionId,
                        messageProvider: typeof ctx?.messageProvider === "string"
                            ? ctx.messageProvider
                            : undefined,
                    });
                    if (source === "web") {
                        const injected = injectCuaOverrideIntoCommand(currentCommand.value, sessionId, escapeShellArg);
                        cuaFallbackReason = injected.reason;
                        if (injected.injected) {
                            modifiedParams[currentCommand.key] = injected.command;
                            injectedCuaArgs = true;
                        }
                    }
                    else {
                        cuaFallbackReason = "non_web";
                    }
                }
            }
            else if (originalArgs && !hasSessionArg(originalArgs)) {
                // Prefer global flag position: `bua --session <id> ...`
                modifiedArgs = ["--session", sessionId, ...originalArgs];
                injectedSession = true;
            }
        }
        else if (cuaCmd && isCuaRunCommandString(cuaCmd.value)) {
            cuaFallbackReason = "no_session";
        }
        // Note: We don't modify event.traceId to avoid mutating input parameters
        // traceId is only used for logging purposes
        const paramsAfter = isFrameworkFormat
            ? modifiedParams
                ? { ...modifiedParams }
                : paramsBefore
            : modifiedArgs
                ? [...modifiedArgs]
                : paramsBefore;
        const beforeSummary = isFrameworkFormat
            ? buildBuaBeforeLogSummary(event, paramsBefore, paramsAfter)
            : { argsBefore: paramsBefore, argsAfter: paramsAfter };
        appendBuaHookLog(api, {
            event: "before_tool_call",
            at: new Date().toISOString(),
            traceId,
            toolName,
            session: sessionId,
            injectedSession,
            injectedCuaArgs,
            cuaFallbackReason,
            ...beforeSummary,
        });
        // Return modified params for OpenClaw framework to apply
        if (isFrameworkFormat &&
            (injectedSession || injectedCuaArgs) &&
            modifiedParams) {
            return { params: modifiedParams };
        }
        if (modifiedArgs) {
            return { args: modifiedArgs };
        }
    };
}
function createAfterToolCallHook(api) {
    return (event, ctx) => {
        // Side effect 1: when main agent invokes cua.sh via bash, prep the IM
        // handoff screenshot from the latest run dir. This is the natural-language
        // path; the /cua slash command path is handled inside handleRunCommand.
        const cmd = resolveCommandStringFromParams(event?.params);
        const sessionKey = resolveSessionId(ctx, event);
        // ============ SPIKE P1 (isolated, flag-gated) ============
        // V3/V4 验证用:isSpikeEnabled() 启用时,在 IM 渠道 + bua/cua 工具调用
        // 后异步触发 plugin 主动调 deliverOutboundPayloads 发图,完全独立于
        // V7 production 路径(V7 仍按既有逻辑跑 — 用户会收到 V7 + spike 双图,
        // 这是预期的实验现象)。spike 永不抛错,即使失败也不破坏 V7。
        // 详见 src/spike-p1-sender.ts。
        if (isSpikeEnabled() && sessionKey) {
            try {
                const messageProvider = typeof ctx?.messageProvider === "string" ? ctx.messageProvider : "";
                const source = detectConversationSource({
                    sessionKey,
                    messageProvider,
                });
                if (source === "im") {
                    const toolName = resolveBuaToolName(event);
                    const triggerReason = toolName === "bua"
                        ? "bua_tool"
                        : cmd && isCuaCommandString(cmd.value)
                            ? "cua_sh_command"
                            : "";
                    if (triggerReason) {
                        void runSpikeP1Send({
                            api,
                            sessionKey,
                            messageProvider,
                            agentId: typeof ctx?.agentId === "string" ? ctx.agentId : undefined,
                            channelId: typeof ctx?.channelId === "string" ? ctx.channelId : undefined,
                            triggerReason,
                        });
                    }
                }
            }
            catch {
                /* spike 永不破坏 V7 */
            }
        }
        // ============ END SPIKE P1 ============
        if (cmd && isCuaCommandString(cmd.value) && isCuaResultInterrupted(event)) {
            try {
                if (sessionKey) {
                    markHandoffSource(sessionKey, "cua");
                }
                const handoffPath = prepImHandoffScreenshotFromLatestRun();
                appendBuaHookLog(api, {
                    event: "after_tool_call_cua",
                    at: new Date().toISOString(),
                    traceId: resolveTraceId(event),
                    session: sessionKey,
                    source: sessionKey ? "cua" : null,
                    handoffPath: handoffPath ?? null,
                });
                // 注意:这里 prep 的 handoff.jpg 是 cua 启动初的桌面状态(cua
                // agent 才刚 spawn),不是 INTERRUPTED 终态。飞书发图触发**不**
                // 放这里,放 llm_output hook(那时 cua agent paused,桌面已是
                // 终态)。详见 src/llm-input-diag-hook.ts createLlmOutputDiagHook。
            }
            catch {
                /* prep failure should never break the hook */
            }
        }
        // Existing BUA tracking
        const toolName = resolveBuaToolName(event);
        if (toolName) {
            const afterSummary = buildBuaAfterLogSummary(event);
            appendBuaHookLog(api, {
                event: "after_tool_call",
                at: new Date().toISOString(),
                traceId: resolveTraceId(event),
                toolName,
                session: sessionKey,
                ...afterSummary,
            });
        }
        const hasBuaScreenshot = isBuaScreenshotToolCall(event) ||
            (cmd ? commandContainsBuaScreenshot(cmd.value) : false);
        if (sessionKey && hasBuaScreenshot && fs.existsSync(DEFAULT_HANDOFF_PATH)) {
            let mtimeMs;
            try {
                mtimeMs = fs.statSync(DEFAULT_HANDOFF_PATH).mtimeMs;
            }
            catch {
                mtimeMs = undefined;
            }
            markHandoffSource(sessionKey, "bua", mtimeMs);
            appendBuaHookLog(api, {
                event: "handoff_source",
                at: new Date().toISOString(),
                traceId: resolveTraceId(event),
                session: sessionKey,
                source: "bua",
                mtimeMs: mtimeMs ?? null,
            });
        }
    };
}
export default definePluginEntry({
    id: "skill-switch",
    name: "Skill Switch",
    description: "Switch active skill for the current session and clean up tool call history",
    register(api) {
        registerSkillSwitchCommand(api);
        registerBuaFocusCommand(api);
        registerCuaCommand(api);
        const skillInjectionHook = createSkillInjectionHook(api);
        api.on("before_prompt_build", wrapHookWithTiming(api, "before_prompt_build", skillInjectionHook));
        api.on("before_tool_call", wrapHookWithTiming(api, "before_tool_call", createBeforeToolCallHook(api)));
        api.on("after_tool_call", wrapHookWithTiming(api, "after_tool_call", createAfterToolCallHook(api)));
        api.on("llm_input", wrapHookWithTiming(api, "llm_input", createLlmInputDiagHook(api)));
        api.on("llm_output", wrapHookWithTiming(api, "llm_output", createLlmOutputDiagHook(api)));
        // 微信 handoff 去重:掐掉 openclaw outbound 对固定 handoff.jpg 的冗余发送
        // (plugin 已在 llm_output 主动发唯一文件名图)。strip MEDIA 对微信无效
        // (outbound 读 hook 前副本),故用 message_sending hook 在文件读之前 cancel,
        // 既不双发也不 ENOENT。详见 wechat-handoff-dedup-hook.ts。
        api.on("message_sending", wrapHookWithTiming(api, "message_sending", createWechatHandoffDedupHook(api)));
        // Wechat IM handoff fallback (non-Feishu IM only): if LLM 在 wait_for_user
        // 回合忘记输 MEDIA 行,通过 before_agent_finalize action=revise 让 LLM
        // 重出一份带 MEDIA 行的 reply,openclaw outbound 派发时拿到 fresh handoff.jpg。
        // 飞书路径不需要 — feishu-handoff-sender direct-send 已经兜底。
        api.on("before_agent_finalize", wrapHookWithTiming(api, "before_agent_finalize", createWechatHandoffRetryHook(api)));
        api.registerGatewayMethod("arkclawSkillSelect.list", async (ctx) => {
            // active skill 已迁移到实例级别;sessionKey 即使传入也忽略,仅做兼容。
            void ctx.params.sessionKey;
            const stateDir = api.runtime.state.resolveStateDir();
            const workspaceDir = resolveWorkspaceDir(api);
            const skills = scanSkillsFromDirectories({
                stateDir,
                workspaceDir,
                config: api.config,
            });
            await updateCachedSkills(stateDir, skills);
            const activeSkillId = await getSessionActiveSkill(stateDir, GLOBAL_CONTEXT_KEY);
            ctx.respond(true, {
                skills: skills.map((s) => ({
                    id: s.id,
                    name: s.name,
                    description: s.description,
                    source: s.source,
                    isActive: s.id === activeSkillId,
                })),
                activeSkillId,
            });
        });
        api.registerGatewayMethod("arkclawSkillSelect.switch", async (ctx) => {
            // active skill 已迁移到实例级别;sessionKey 即使传入也忽略,仅做兼容。
            const skillId = ctx.params.skillId;
            const stateDir = api.runtime.state.resolveStateDir();
            const workspaceDir = resolveWorkspaceDir(api);
            const skills = scanSkillsFromDirectories({
                stateDir,
                workspaceDir,
                config: api.config,
            });
            await updateCachedSkills(stateDir, skills);
            if (!skillId) {
                const currentSkillId = await getStoredActiveSkill(stateDir, GLOBAL_CONTEXT_KEY);
                await setSessionActiveSkill(stateDir, GLOBAL_CONTEXT_KEY, null);
                ctx.respond(true, {
                    action: "cleared",
                    previousSkillId: currentSkillId,
                    skills: skills.map((s) => ({
                        id: s.id,
                        name: s.name,
                        description: s.description,
                        source: s.source,
                        isActive: false,
                    })),
                });
                return;
            }
            const targetSkill = skills.find((s) => s.id === skillId);
            if (!targetSkill) {
                // CLI 端 ajv ErrorShapeSchema additionalProperties:false 拒绝顶层
                // 自定义字段 → availableSkills 必须放进 details，否则 CLI 永不 resolve
                // → 10s timeout（详见 src/video-to-prompt/gateway.ts:respondError 注释）。
                ctx.respond(false, undefined, {
                    code: "SKILL_NOT_FOUND",
                    message: `Skill "${skillId}" not found`,
                    details: { availableSkills: skills.map((s) => s.id) },
                });
                return;
            }
            await setSessionActiveSkill(stateDir, GLOBAL_CONTEXT_KEY, skillId);
            const cleanResult = await cleanToolCallsFromHistory(api, GLOBAL_CONTEXT_KEY);
            const response = {
                action: "switched",
                skill: {
                    id: targetSkill.id,
                    name: targetSkill.name,
                    description: targetSkill.description,
                    source: targetSkill.source,
                },
                cleanedToolCalls: cleanResult.cleanedCount,
            };
            if (cleanResult.lastUserMessage) {
                response.reprocessing = true;
                try {
                    await triggerReprocess(api, GLOBAL_CONTEXT_KEY, cleanResult.lastUserMessage);
                }
                catch (err) {
                    response.reprocessing = false;
                    response.reprocessError = String(err);
                }
            }
            ctx.respond(true, response);
        });
        api.registerGatewayMethod("arkclawSkillSelect.focus", async (ctx) => {
            const sessionId = resolveSessionId(ctx?.params);
            if (!sessionId) {
                ctx.respond(false, undefined, {
                    code: "INVALID_REQUEST",
                    message: "session is required",
                });
                return;
            }
            const result = await executeBuaFocus(api, sessionId);
            if (!result.ok) {
                ctx.respond(false, undefined, {
                    code: "BUA_FOCUS_FAILED",
                    message: result.errorMessage ?? `bua focus failed for session: ${sessionId}`,
                    exitCode: result.exitCode,
                    signal: result.signal,
                    stdout: result.stdout,
                    stderr: result.stderr,
                });
                return;
            }
            ctx.respond(true, {
                session: sessionId,
                sessionKey: sessionId,
                command: ["bua", ...result.command],
                exitCode: result.exitCode,
                signal: result.signal,
                stdout: result.stdout,
                stderr: result.stderr,
                // 当 sid 未在 bua 侧登记 / 窗口已失效时, skipped=true, 调用方据此
                // 判断"无浏览器可 focus 但非异常",避免误报错误
                ...(result.skipped ? { skipped: true, reason: result.reason } : {}),
            });
        });
        // video-to-prompt module: recording + analysis. See src/video-to-prompt/.
        const vtpApi = api;
        // 二期 P4 (ADR-0028): plugin 端已接入 OTel —— gateway.ts
        // registerCuaRecordingGateway 头部 initOtel("plugin") 启 NodeSDK,
        // observability/{tracer,metrics,logger}.ts 是真实现(span / counter /
        // 滚动文件日志),不再是 no-op stub。9 个 @opentelemetry/* 依赖全为纯
        // JS 包(OTel JS SDK 生态无 native binding / 无 postinstall 编译),
        // 与 plugin install 的 `npm install --ignore-scripts` 兼容
        // (openclaw-standards §2.11)。仍延后的只是 plugin → runtime SEA 的
        // traceparent 跨进程传播:host 若注入 traceparent 到 plugin process
        // env,plugin 转发到 VTP_TRACEPARENT,runtime SEA 的 OTel
        // propagation.extract 接父 span;当前两侧 trace 各自独立。
        registerCuaRecordingCommand(vtpApi);
        registerCuaRecordingGateway(vtpApi);
        startMaintenanceScheduler(vtpApi);
        // 二期 F-B: 任务模板域 AUTO-INDEX 周期 self-heal scheduler。
        // 与 cleanup-scheduler (录制域) 解耦 — D-20 双域;运维 out-of-band
        // 增删 reference/<slug>/ 后 N 小时内被 rebuildCuaRecordingIndex 自愈。
        // 间隔从 configSchema.skillIndexRebuildIntervalHours 读 (default 1h,
        // 设 0 = 仅 startup self-heal)。fire-and-forget,失败 warn 不阻塞。
        const vtpCfg = readSkillsConfig(vtpApi);
        const vtpWorkspaceDir = resolveWorkspaceDir(vtpApi);
        const vtpRecordingDir = path.join(vtpWorkspaceDir, vtpCfg.vtpRecordingRoot);
        startSkillIndexScheduler({
            intervalHours: vtpCfg.skillIndexRebuildIntervalHours,
            // rebuildCuaRecordingIndex now returns { slugCount, changed } so the
            // scheduler can record the real vtp.skill_index.entry_count histogram
            // value instead of always emitting 0.
            rebuildFn: () => rebuildCuaRecordingIndex(vtpRecordingDir),
        });
    },
});
//# sourceMappingURL=index.js.map