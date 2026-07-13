import { parseSessionKeyFromArgs, resolveSessionKey } from "./utils.js";
import { scanSkillsFromDirectories } from "./skill-discovery.js";
import { getStoredActiveSkill, setSessionActiveSkill, GLOBAL_CONTEXT_KEY, updateCachedSkills, } from "./session-state.js";
import { cleanToolCallsFromHistory } from "./history-cleaner.js";
import { triggerReprocess } from "./reprocess.js";
import { resolveWorkspaceDir } from "./workspace.js";
function parseCommandArgs(rawArgs) {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return { skillId: null };
    }
    // skill-switch 已迁移到实例级别(全局生效);仍解析 `--session` / `-s`
    // 仅为兼容旧调用方,解析后忽略其值。
    const tokens = [];
    const parts = trimmed.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "--session" || part === "-s") {
            i++; // skip the next token (session value)
            continue;
        }
        if (part.startsWith("--session=") || part.startsWith("-s=")) {
            continue;
        }
        tokens.push(part);
    }
    const skillId = tokens[0] ?? null;
    return { skillId };
}
export function registerSkillSwitchCommand(api) {
    api.registerCommand({
        name: "skill-switch",
        description: "Switch active skill globally for this instance",
        acceptsArgs: true,
        async handler(ctx) {
            const rawArgs = ctx.args?.trim() ?? "";
            const { skillId } = parseCommandArgs(rawArgs);
            if (!skillId) {
                return handleClearCommand(ctx, api, GLOBAL_CONTEXT_KEY);
            }
            return handleSwitchCommand(ctx, api, GLOBAL_CONTEXT_KEY, skillId);
        },
    });
}
export function registerBuaFocusCommand(api) {
    api.registerCommand({
        name: "bua-focus",
        description: "Focus current page for the specified session",
        acceptsArgs: true,
        async handler(ctx) {
            const failResponse = { text: "bua-focus 失败", type: "error" };
            const okResponse = { text: "bua-focus 成功", type: "focused" };
            const rawArgs = ctx.args?.trim() ?? "";
            let sessionKey = parseSessionKeyFromArgs(rawArgs);
            if (!sessionKey) {
                sessionKey = resolveSessionKey(ctx);
            }
            if (!sessionKey) {
                return failResponse;
            }
            const result = await executeBuaFocus(api, sessionKey);
            if (!result.ok) {
                return failResponse;
            }
            if (result.skipped) {
                // session 未在 bua 登记 / 窗口已失效，属于正常无浏览器状态
                return { text: "bua-focus 跳过：当前会话无活动浏览器窗口", type: "focused" };
            }
            return okResponse;
        },
    });
}
export async function executeBuaFocus(api, sessionKey) {
    // Prefer global flag position: `bua --session <id> focus`
    const command = ["--session", sessionKey, "focus"];
    const workspaceDir = resolveWorkspaceDir(api);
    const baseFail = {
        ok: false,
        command,
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
    };
    const runner = api.runtime.system?.runCommandWithTimeout;
    if (typeof runner !== "function") {
        return { ...baseFail, errorMessage: "当前 OpenClaw 运行时未提供 system.runCommandWithTimeout，无法执行 bua focus" };
    }
    // 只读探测：bua --session <sid> has-window
    //   exit 0 = sid 已登记且 windowId 仍活，可以继续 focus
    //   exit 1 = sid 已登记但 window 已失效（视作正常无浏览器会话）
    //   exit 2 = sid 未登记（纯文本会话，从未跑过 bua open）
    // 由于 bua 与 plugin 同步部署（>= 1.15.0），这里直接信任 has-window 契约。
    let probeStdout = "";
    let probeStderr = "";
    let probeSignal = null;
    let probeExit = null;
    const probeCommand = ["--session", sessionKey, "has-window"];
    try {
        const probe = await runner(["bua", ...probeCommand], { timeoutMs: 5_000, cwd: workspaceDir });
        probeStdout = probe.stdout ?? "";
        probeStderr = probe.stderr ?? "";
        probeSignal = probe.signal ?? null;
        probeExit = typeof probe.code === "number" ? probe.code : null;
    }
    catch (err) {
        return { ...baseFail, command: probeCommand, errorMessage: `bua has-window 探测失败: ${err?.message ?? String(err)}` };
    }
    if (probeExit === 1 || probeExit === 2) {
        return {
            ok: true,
            skipped: true,
            reason: "no_browser_session",
            command: probeCommand,
            exitCode: probeExit,
            signal: probeSignal,
            stdout: probeStdout,
            stderr: probeStderr,
        };
    }
    if (probeExit !== 0) {
        return {
            ok: false,
            command: probeCommand,
            exitCode: probeExit,
            signal: probeSignal,
            stdout: probeStdout,
            stderr: probeStderr,
            errorMessage: probeStderr.trim() || `bua has-window exited with code ${probeExit ?? "unknown"}`,
        };
    }
    try {
        const result = await runner(["bua", ...command], { timeoutMs: 15_000, cwd: workspaceDir });
        const stdout = result.stdout ?? "";
        const stderr = result.stderr ?? "";
        const exitCode = typeof result.code === "number" ? result.code : null;
        const signal = result.signal ?? null;
        if (exitCode !== 0) {
            return {
                ok: false,
                command,
                exitCode,
                signal,
                stdout,
                stderr,
                errorMessage: stderr.trim() || `Command exited with code ${exitCode ?? "unknown"}`,
            };
        }
        return {
            ok: true,
            command,
            exitCode,
            signal,
            stdout,
            stderr,
        };
    }
    catch (err) {
        return { ...baseFail, errorMessage: err?.message ?? String(err) };
    }
}
async function handleClearCommand(_ctx, api, contextKey) {
    const stateDir = api.runtime.state.resolveStateDir();
    const workspaceDir = resolveWorkspaceDir(api);
    const skills = scanSkillsFromDirectories({
        stateDir,
        workspaceDir,
        config: api.config,
    });
    await updateCachedSkills(stateDir, skills);
    const currentSkillId = await getStoredActiveSkill(stateDir, contextKey);
    const activeSkill = currentSkillId ? skills.find((s) => s.id === currentSkillId) : null;
    await setSessionActiveSkill(stateDir, contextKey, null);
    const lines = [];
    if (skills.length === 0) {
        lines.push("No skills available.");
    }
    else {
        lines.push("Available skills:", "");
        for (const skill of skills) {
            const wasActive = activeSkill?.id === skill.id;
            const marker = wasActive ? " [was active, now cleared]" : "";
            const source = skill.source === "builtin" ? " (built-in)" : ` (${skill.source})`;
            lines.push(`  • ${skill.id}${marker}${source}`);
            if (skill.description) {
                lines.push(`    ${skill.description}`);
            }
        }
    }
    lines.push("");
    lines.push("Skill injection cleared. No active skill will be injected.");
    lines.push("");
    lines.push("Usage:");
    lines.push("  /skill-switch <id>  - Switch to specified skill");
    return {
        text: lines.join("\n"),
        type: "cleared",
        skills,
        activeSkill: null,
    };
}
async function handleSwitchCommand(_ctx, api, contextKey, skillId) {
    const stateDir = api.runtime.state.resolveStateDir();
    const workspaceDir = resolveWorkspaceDir(api);
    const skills = scanSkillsFromDirectories({
        stateDir,
        workspaceDir,
        config: api.config,
    });
    const targetSkill = skills.find((s) => s.id === skillId);
    if (!targetSkill) {
        return {
            text: `Skill "${skillId}" not found. Use /skill-switch to list available skills.`,
            type: "error",
        };
    }
    // 必须在写入 active skill 之前刷新 cachedSkills,否则首次启动 / 缓存被清理时
    // before_prompt_build 通过 getCachedSkills() 找不到 SkillInfo,override 不会
    // 注入到 prompt,本次切换对对话不生效。
    await updateCachedSkills(stateDir, skills);
    await setSessionActiveSkill(stateDir, contextKey, skillId);
    const cleanResult = await cleanToolCallsFromHistory(api, contextKey);
    let responseText = `Switched to skill: ${skillId}`;
    if (cleanResult.cleanedCount > 0) {
        responseText += `\nCleaned ${cleanResult.cleanedCount} tool call(s) from history.`;
    }
    if (cleanResult.lastUserMessage) {
        try {
            await triggerReprocess(api, contextKey, cleanResult.lastUserMessage);
            responseText += "\nReprocessing last user message...";
        }
        catch (err) {
            responseText += `\nWarning: Could not reprocess: ${err}`;
        }
    }
    return {
        text: responseText,
        type: "switched",
        activeSkill: targetSkill,
    };
}
//# sourceMappingURL=commands.js.map