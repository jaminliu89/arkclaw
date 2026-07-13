import { spawn, spawnSync, execSync } from "child_process";
import readline from "readline";
import path from "path";
import fs from "fs";
import os from "os";
import { markHandoffSource } from "./handoff-source.js";
import { buildCuaOverrideArgv } from "./cua-session-model.js";
const CUA_BIN = "/root/.agents/skills/computer-use/scripts/cua.sh";
const LOG_DIR = "/root/.agents/skills/computer-use/scripts/";
const LOG_FILE = path.join(LOG_DIR, "cua_plugin.log");
const RUNS_BASE_DIR = "/root/.cua/runs";
const TASK_STATE_FILE = "/root/.cua/task_state.json";
const IGNORED_DIRS = new Set(["output", "images"]);
let legacyHandoffClearedForFreshCapture = false;
function jsonResponse(data, fallbackType = "list") {
    return { text: JSON.stringify(data, null, 2), type: fallbackType };
}
let currentTask = null;
function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath))
            return null;
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    catch (_) {
        return null;
    }
}
function saveTaskState(state) {
    try {
        const dir = path.dirname(TASK_STATE_FILE);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(TASK_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
        logToFile(`[TaskState] Saved: type=${state.type}, runId=${state.runId}`);
    }
    catch (e) {
        logToFile(`[TaskState] Failed to save: ${String(e)}`);
    }
}
function loadTaskState() {
    return readJsonFile(TASK_STATE_FILE);
}
function clearTaskState() {
    try {
        if (fs.existsSync(TASK_STATE_FILE)) {
            fs.unlinkSync(TASK_STATE_FILE);
            logToFile(`[TaskState] Cleared ${TASK_STATE_FILE}`);
        }
    }
    catch (e) {
        logToFile(`[TaskState] Failed to clear: ${String(e)}`);
    }
}
function syncTaskStateFromDisk() {
    if (currentTask?.process)
        return;
    const state = loadTaskState();
    if (!state)
        return;
    if (state.type === "running" && state.pid) {
        if (!isProcessAlive(state.pid)) {
            logToFile(`[Sync] Task ${state.runId} process dead (pid ${state.pid}), clearing state`);
            clearTaskState();
            return;
        }
    }
    logToFile(`[Sync] Recovering task from disk: type=${state.type}, runId=${state.runId}`);
    currentTask = {
        id: state.runId,
        prompt: state.prompt,
        startTime: state.startTime
            ? new Date(state.startTime).getTime()
            : Date.now(),
        runsDir: state.runsDir,
        isInterrupted: state.type === "interrupted",
        interruptReason: state.interruptReason,
        historySteps: [],
    };
}
/**
 * Capture a fresh desktop screenshot into an outbound media path. The current
 * IM handoff path uses `captureFreshHandoffScreenshot()` to write a unique
 * `handoff-fresh-*.jpg` file; the fixed `handoff.jpg` path remains only for
 * legacy CUA prep/diagnostics and is not used as the IM send source.
 *
 * Why direct capture instead of reading cua's run dir: cua agent prunes
 * step_*.jpg files at run end (artifacts.pruneAfterRun=true is the default
 * in this deployment; agent.ts:3318 `shouldArchiveOutput` excludes anything
 * starting with `step_` from archival, so they're unlinked). Any path that
 * tries to read those files races against cua and loses.
 *
 * Mirrors the BUA path conceptually: instead of reusing the sub-agent's
 * artifacts, take our own screenshot at hook time. Uses ImageMagick `import`
 * with the same `DISPLAY` (default :99 = typical xvfb headless setup).
 *
 * Output path must be under `outbound/` subdir per
 * openclaw/src/agents/sandbox-paths.ts:19 MANAGED_MEDIA_SUBDIRS; any other
 * subdir under `~/.openclaw/media/` is rejected with "Media failed".
 *
 * Returns the prepared path on success, or null on failure (capture binary
 * missing, X server unreachable, fs error). Callers must not fallback to a
 * previous fixed `handoff.jpg` when this returns null.
 */
function captureHandoffScreenshotTo(outPath) {
    const trace = (msg) => {
        try {
            const logPath = path.join(process.env.HOME || os.homedir(), ".openclaw", "extensions", "skill-switch", "cua-handoff-prep.log");
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), msg }) + "\n", "utf8");
        }
        catch {
            /* never break */
        }
    };
    const outDir = path.dirname(outPath);
    const display = process.env.DISPLAY || ":99";
    try {
        fs.mkdirSync(outDir, { recursive: true });
        // Primary: ImageMagick `import` (we already use `convert` from the
        // same package, so `import` should be available).
        const cap = spawnSync("import", ["-window", "root", "-resize", "1280x1280>", outPath], {
            env: { ...process.env, DISPLAY: display },
            timeout: 10_000,
        });
        trace(`import exit=${cap.status} err=${cap.error?.message ?? "none"} stderr=${(cap.stderr ?? "").toString().slice(0, 200)}`);
        if (cap.status === 0 && fs.existsSync(outPath)) {
            trace(`success (import): ${outPath}`);
            return outPath;
        }
        // Fallback: scrot
        const sc = spawnSync("scrot", ["-o", outPath], {
            env: { ...process.env, DISPLAY: display },
            timeout: 10_000,
        });
        trace(`scrot exit=${sc.status} err=${sc.error?.message ?? "none"} stderr=${(sc.stderr ?? "").toString().slice(0, 200)}`);
        if (sc.status === 0 && fs.existsSync(outPath)) {
            trace(`success (scrot): ${outPath}`);
            return outPath;
        }
        trace(`bail: all capture binaries failed`);
        return null;
    }
    catch (err) {
        trace(`exception: ${String(err)}`);
        logToFile(`[Run] prepImHandoffScreenshot failed: ${String(err)}`);
        return null;
    }
}
function prepImHandoffScreenshot() {
    const outDir = path.join(process.env.HOME || os.homedir(), ".openclaw", "media", "outbound");
    return captureHandoffScreenshotTo(path.join(outDir, "handoff.jpg"));
}
export function captureFreshHandoffScreenshot() {
    const outDir = path.join(process.env.HOME || os.homedir(), ".openclaw", "media", "outbound");
    if (!legacyHandoffClearedForFreshCapture) {
        legacyHandoffClearedForFreshCapture = true;
        try {
            fs.rmSync(path.join(outDir, "handoff.jpg"), { force: true });
        }
        catch {
            /* never break fresh capture */
        }
    }
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return captureHandoffScreenshotTo(path.join(outDir, `handoff-fresh-${unique}.jpg`));
}
/**
 * Just-in-time fresh capture into the fixed `handoff.jpg` path used by the
 * standard openclaw outbound MEDIA directive. Used for non-Feishu IM channels
 * (wechat etc.) where the outbound dispatcher reads raw MEDIA: path and the
 * plugin cannot rewrite the path via llm_output mutation (runVoidHook does not
 * propagate plugin event mutations, see openclaw/src/plugins/hooks.ts:557).
 *
 * tmp + rename pattern: capture into a temporary file first, then atomically
 * rename to `handoff.jpg`. POSIX rename is atomic within the same filesystem,
 * so the outbound dispatcher either sees the old complete file or the new
 * complete file — never a half-written one.
 *
 * Capture failure semantics: do NOT delete the existing `handoff.jpg`. If
 * capture fails the user gets the (stale) previous frame instead of `⚠️ Media
 * failed`. This is the explicit user decision: showing a slightly outdated
 * screenshot is better UX than a failure marker.
 *
 * 时序正确性依赖链(升级 openclaw 时必须 verify 这条链未被打破):
 *   1. plugin llm_output hook handler 同步早期调用 `captureHandoffScreenshotTo`
 *      → spawnSync("import", ..., timeout: 10s) **native sync block** 当前
 *      event loop tick;
 *   2. openclaw runVoidHook(hooks.ts:557)用
 *      `hooks.map(async (hook) => { ... })` 同步调每个 handler,handler
 *      body 同步部分(包括 spawnSync)在 `await Promise.all(...)` 之前
 *      就跑完;
 *   3. openclaw attempt.ts:4662 调用点是
 *      `hookRunner.runLlmOutput(...).catch(...)`(fire-and-forget),attempt
 *      主线程同步继续到 outbound dispatch — 但同一 event loop tick 已经被
 *      spawnSync block,所以 attempt 主线程到达 outbound dispatch 时,
 *      tmp 文件已写完 + rename 已完成。
 * 如果上游把 hook handler 调用挪到 microtask(`Promise.resolve().then`)或
 * 在 attempt outbound dispatch 链路上插入 await 边界,这条 guarantee 会破,
 * outbound 可能读到旧 handoff.jpg。升级 openclaw 时务必 grep `runLlmOutput`
 * + `runVoidHook` 实现确认。
 *
 * 单 DISPLAY 假设(并发):本函数抓 X11 DISPLAY=:99 root window,所有 session
 * 共享同一桌面。多用户/多 session 并发 capture 时,后到的 capture 会覆盖
 * 前一个 session 的 handoff.jpg。tmp 文件名带 pid+ts+random 只防 tmp 撞名,
 * 不防终态 handoff.jpg 撞名。本质上桌面图像就是单租户(:99 上只能跑一个
 * chrome/desktop),plugin 层不做 per-session 隔离 — 长期方案应改 unique
 * 文件名 + 改 SKILL.md 让 LLM 输 unique 路径,但那要换发送协议。
 */
export function captureHandoffScreenshotInPlace() {
    const outDir = path.join(process.env.HOME || os.homedir(), ".openclaw", "media", "outbound");
    const outPath = path.join(outDir, "handoff.jpg");
    // CRITICAL: tmp 文件名必须以 .jpg 结尾 — ImageMagick `import` 看输出扩展名
    // 决定编码格式,未知扩展名会 fallback 到无压缩格式(BMP/raw),产物既不是
    // 有效 JPEG 也巨大(实测 5.6MB vs 应有 ~150KB),后续 rename 成 handoff.jpg
    // 文件**内容仍非 JPEG**,微信 channel 上传识别为损坏媒体 → "媒体文件上传
    // 失败,请稍后重试"。把唯一性后缀放在 .jpg **之前**而不是之后。
    const tmpPath = path.join(outDir, `handoff.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    // Defensive runtime guard:防未来有人手改上面的 template literal 把 .jpg
    // 后缀挪到中间或删掉,导致 import 输出非 JPEG(已发生过一次,见 commit 741ef914)。
    // 这条 assert 不会在正常路径触发 — 触发即说明代码 regression,直接 bail。
    if (!tmpPath.endsWith(".jpg"))
        return null;
    try {
        fs.mkdirSync(outDir, { recursive: true });
    }
    catch {
        return null;
    }
    const captured = captureHandoffScreenshotTo(tmpPath);
    if (!captured || !fs.existsSync(tmpPath)) {
        return null;
    }
    try {
        fs.renameSync(tmpPath, outPath);
        return outPath;
    }
    catch {
        try {
            fs.rmSync(tmpPath, { force: true });
        }
        catch {
            /* never break */
        }
        return null;
    }
}
/**
 * Legacy CUA prep hook: capture current desktop to the fixed handoff path for
 * diagnostics/source tracking. The IM sender no longer reads this path; it
 * captures its own unique file when it sees handoff intent.
 */
export function prepImHandoffScreenshotFromLatestRun() {
    // Direct desktop capture; ignores cua run dir entirely (cua prunes
    // step_*.jpg, can't rely on those files). See prepImHandoffScreenshot.
    return prepImHandoffScreenshot();
}
function resolveFinalStatus(success, error, reason, brain) {
    if (success === "interrupted" || brain?.should_wait_for_user) {
        return { status: "INTERRUPTED" /* TaskStatus.INTERRUPTED */, reason };
    }
    if (success === false || error) {
        return { status: "FAILED" /* TaskStatus.FAILED */, reason: reason || error };
    }
    if (success === true) {
        return { status: "SUCCESS" /* TaskStatus.SUCCESS */, reason };
    }
    return {};
}
function resolveInterruptReason(task, diskResult) {
    const state = loadTaskState();
    return (task.interruptReason ||
        state?.interruptReason ||
        diskResult?.finalReason ||
        "需要用户手动操作");
}
function killProcessTree(pid, taskId) {
    try {
        if (process.platform !== "win32") {
            logToFile(`[Stop] Killing process group -${pid} for task ${taskId}`);
            process.kill(-pid, "SIGTERM");
        }
        else {
            logToFile(`[Stop] Killing process ${pid} for task ${taskId}`);
            process.kill(pid, "SIGTERM");
        }
    }
    catch (e) {
        console.error(`[CUA] Failed to kill process group for task ${taskId}:`, e);
        logToFile(`[Stop] Failed to kill process group for task ${taskId}: ${String(e)}`);
        try {
            process.kill(pid, "SIGTERM");
        }
        catch (killErr) {
            console.error(`[CUA] Failed to kill process directly for task ${taskId}:`, killErr);
            logToFile(`[Stop] Fallback killing failed for task ${taskId}: ${String(killErr)}`);
        }
    }
}
function logToFile(msg) {
    try {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
        const ts = new Date().toISOString();
        fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`, "utf8");
    }
    catch (_) { }
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (_) {
        return false;
    }
}
function getLatestRunDir() {
    try {
        if (!fs.existsSync(RUNS_BASE_DIR))
            return null;
        const dirs = fs
            .readdirSync(RUNS_BASE_DIR, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => {
            const fullPath = path.join(RUNS_BASE_DIR, d.name);
            return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        })
            .sort((a, b) => b.mtime - a.mtime);
        return dirs.length > 0 ? dirs[0].path : null;
    }
    catch (e) {
        logToFile(`[getLatestRunDir] Error: ${String(e)}`);
        return null;
    }
}
function extractRationale(step) {
    if (step.llm?.rationales?.length > 0)
        return step.llm.rationales[0];
    if (step.rationale)
        return step.rationale;
    if (step.args?.rationale)
        return step.args.rationale;
    if (step.actionName)
        return `执行操作: ${step.actionName}`;
    if (step.actionArgs)
        return `执行参数: ${JSON.stringify(step.actionArgs)}`;
    if (step.name || step.action)
        return `执行操作: ${step.name || step.action}`;
    return "";
}
function buildStatusSteps(filePath, isReversed) {
    const steps = [];
    try {
        if (!fs.existsSync(filePath))
            return steps;
        const raw = fs.readFileSync(filePath, "utf8");
        let records;
        if (isReversed) {
            const data = JSON.parse(raw);
            records = Array.isArray(data.steps) ? [...data.steps].reverse() : [];
        }
        else {
            records = raw
                .split("\n")
                .filter((l) => l.trim())
                .map((l) => {
                try {
                    return JSON.parse(l);
                }
                catch {
                    return null;
                }
            })
                .filter(Boolean);
        }
        for (const s of records) {
            steps.push({
                step: s.step ?? 0,
                rationale: extractRationale(s),
                actionName: s.actionName ?? null,
                success: s.success ?? s.tool?.success ?? null,
            });
        }
    }
    catch (_) { }
    return steps;
}
function addUniqueRationale(rationales, rationale) {
    if (rationale && rationales[rationales.length - 1] !== rationale) {
        rationales.push(rationale);
    }
}
function parseStepsJsonl(filePath) {
    const rationales = [];
    const steps = buildStatusSteps(filePath, false);
    let finalStatus;
    let finalReason;
    try {
        if (!fs.existsSync(filePath))
            return { rationales, steps };
        const lines = fs
            .readFileSync(filePath, "utf8")
            .split("\n")
            .filter((l) => l.trim());
        for (const line of lines) {
            try {
                const step = JSON.parse(line);
                addUniqueRationale(rationales, extractRationale(step));
                const resolved = resolveFinalStatus(step.success, step.error, step.reason, step.brain);
                if (resolved.status) {
                    finalStatus = resolved.status;
                    finalReason = resolved.reason;
                }
            }
            catch (_) { }
        }
    }
    catch (e) {
        logToFile(`[parseStepsJsonl] Error: ${String(e)}`);
    }
    return { rationales, steps, finalStatus, finalReason };
}
function parseStepsJson(filePath) {
    const rationales = [];
    const steps = buildStatusSteps(filePath, true);
    let finalStatus;
    let finalReason;
    try {
        if (!fs.existsSync(filePath))
            return { rationales, steps };
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const resolved = resolveFinalStatus(data.success, data.error, data.reason);
        if (resolved.status) {
            finalStatus = resolved.status;
            finalReason = resolved.reason;
        }
        if (Array.isArray(data.steps)) {
            for (const step of [...data.steps].reverse()) {
                addUniqueRationale(rationales, extractRationale(step));
            }
        }
    }
    catch (e) {
        logToFile(`[parseStepsJson] Error: ${String(e)}`);
    }
    return { rationales, steps, finalStatus, finalReason };
}
function waitForRunId(maxWaitMs = 15000) {
    return new Promise((resolve) => {
        const checkInterval = 200;
        let elapsed = 0;
        const timer = setInterval(() => {
            elapsed += checkInterval;
            if (currentTask && currentTask.id !== "pending") {
                clearInterval(timer);
                resolve();
            }
            else if (elapsed >= maxWaitMs) {
                clearInterval(timer);
                resolve();
            }
        }, checkInterval);
    });
}
function isCuaProcessRunning() {
    if (currentTask?.process?.pid) {
        return isProcessAlive(currentTask.process.pid);
    }
    const state = loadTaskState();
    if (state?.pid) {
        return isProcessAlive(state.pid);
    }
    try {
        const stdout = execSync(`ps -ef | grep "bash ${CUA_BIN}" | grep -v grep`, {
            encoding: "utf8",
        });
        return stdout.trim().length > 0;
    }
    catch (_) {
        return false;
    }
}
function checkAndSyncTaskState() {
    if (currentTask?.process)
        return;
    if (currentTask && !isCuaProcessRunning()) {
        if (!currentTask.isInterrupted) {
            currentTask.process = undefined;
        }
    }
    if (!currentTask) {
        syncTaskStateFromDisk();
    }
}
function parseSseLine(line) {
    const trimmed = line.trim();
    let jsonStr = trimmed;
    if (trimmed.startsWith("data: "))
        jsonStr = trimmed.slice(6);
    if (!jsonStr.startsWith("{") || !jsonStr.endsWith("}"))
        return null;
    try {
        return JSON.parse(jsonStr);
    }
    catch (_) {
        return null;
    }
}
function spawnCuaProcess(prompt, sessionKey) {
    const overrideArgv = buildCuaOverrideArgv(sessionKey);
    const child = spawn("bash", [CUA_BIN, "run", ...overrideArgv, prompt], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: process.env,
    });
    child.unref();
    if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout });
        rl.on("line", (line) => {
            const data = parseSseLine(line);
            if (!data || !currentTask)
                return;
            if (data.type === "run_detected" && data.run_id) {
                logToFile(`[Run] Task detected real run_id: ${data.run_id}, runs_dir: ${data.runs_dir}`);
                currentTask.id = data.run_id;
                if (data.runs_dir) {
                    currentTask.runsDir = data.runs_dir;
                }
            }
            currentTask.latestStepInfo = data;
            currentTask.historySteps?.push(data);
            if (data.type === "computer_handoff" ||
                (data.type === "done" &&
                    data.success === "interrupted" &&
                    data.reason?.startsWith("needs_user:"))) {
                currentTask.isInterrupted = true;
            }
        });
    }
    if (child.stderr) {
        child.stderr.on("data", (data) => {
            logToFile(`[CUA stderr] ${data.toString()}`);
        });
    }
    child.on("error", (err) => {
        console.error(`[CUA] Task failed to start:`, err);
        logToFile(`[Run] Task process failed to start: ${err.message}`);
        if (currentTask?.process === child) {
            currentTask = null;
        }
    });
    child.on("exit", (code, signal) => {
        logToFile(`[Run] Task process exited with code ${code}, signal ${signal}`);
        if (currentTask?.process === child) {
            currentTask.process = undefined;
        }
    });
    return child;
}
function buildResumePrompt(originalPrompt, interruptReason, userNote) {
    const parts = [
        originalPrompt,
        "",
        `[上下文] 此任务之前执行到需要用户手动操作的阶段: ${interruptReason}`,
        "用户已完成手动操作，请检查当前页面状态并继续执行剩余步骤。",
        "注意：不要重复已完成的操作，直接从当前屏幕状态继续。",
    ];
    if (userNote) {
        parts.push(`用户备注: ${userNote}`);
    }
    return parts.join("\n");
}
function parseCuaCommandArgs(rawArgs) {
    const trimmed = rawArgs.trim();
    if (!trimmed)
        return { subCommand: null, targetArg: null, flags: new Set() };
    const parts = trimmed.split(/\s+/);
    const flags = new Set();
    const nonFlagParts = [];
    for (const part of parts) {
        if (part.startsWith("--")) {
            flags.add(part.toLowerCase());
        }
        else {
            nonFlagParts.push(part);
        }
    }
    return {
        subCommand: nonFlagParts[0] ?? null,
        targetArg: nonFlagParts.length > 1 ? nonFlagParts.slice(1).join(" ") : null,
        flags,
    };
}
export function registerCuaCommand(api) {
    api.registerCommand({
        name: "cua",
        description: "Computer Use Agent (CUA) management and task execution",
        acceptsArgs: true,
        async handler(ctx) {
            const rawArgs = ctx.args?.trim() ?? "";
            logToFile(`[Command Received] /cua ${rawArgs}`);
            const { subCommand, targetArg, flags } = parseCuaCommandArgs(rawArgs);
            if (!subCommand)
                return handleHelpCommand();
            switch (subCommand.toLowerCase()) {
                case "run":
                    return handleRunCommand(targetArg, flags, ctx.sessionKey);
                case "status":
                    return handleStatusCommand(targetArg);
                case "stop":
                    return handleStopCommand(targetArg);
                case "continue":
                    return handleContinueCommand(targetArg, ctx.sessionKey);
                case "list":
                    return handleListCommand();
                default:
                    return handleUnknownCommand(subCommand);
            }
        },
    });
}
function handleHelpCommand() {
    const resp = {
        command: "cua",
        usage: [
            {
                cmd: "/cua run <prompt>",
                description: "Start a CUA task and wait for result (streaming)",
            },
            {
                cmd: "/cua run --async <prompt>",
                description: "Start a CUA task and return immediately",
            },
            {
                cmd: "/cua status",
                description: "Check current CUA task status and progress",
            },
            { cmd: "/cua stop", description: "Stop the currently running CUA task" },
            {
                cmd: "/cua continue [note]",
                description: "Continue the last interrupted task after user operation",
            },
            { cmd: "/cua list", description: "List all CUA tasks" },
        ],
    };
    return jsonResponse(resp, "help");
}
async function handleRunCommand(targetArg, flags, sessionKey) {
    checkAndSyncTaskState();
    if (currentTask?.process ||
        (currentTask && !currentTask.isInterrupted && isCuaProcessRunning())) {
        logToFile(`[Run] Blocked: A task is already running (Task ID: ${currentTask.id})`);
        const resp = {
            runId: currentTask.id,
            status: "INTERRUPTED" /* TaskStatus.INTERRUPTED */,
            prompt: currentTask.prompt,
            message: "A CUA task is already running. Use /cua stop before starting a new task.",
        };
        return jsonResponse(resp, "error");
    }
    if (!targetArg) {
        logToFile(`[Run] Error: Missing prompt argument.`);
        const resp = {
            runId: "",
            status: "ERROR" /* TaskStatus.ERROR */,
            message: "Missing prompt argument. Example: /cua run Open the browser and search for weather",
        };
        return jsonResponse(resp, "error");
    }
    logToFile(`[Run] Starting task with prompt: "${targetArg}". Using CUA_BIN: ${CUA_BIN}`);
    const child = spawnCuaProcess(targetArg, sessionKey);
    currentTask = {
        id: "pending",
        prompt: targetArg,
        startTime: Date.now(),
        process: child,
        latestStepInfo: null,
        historySteps: [],
        isInterrupted: false,
    };
    await waitForRunId();
    const resolvedId = currentTask?.id ?? "pending";
    if (flags.has("--async")) {
        const resp = {
            runId: resolvedId,
            status: "RUNNING" /* TaskStatus.RUNNING */,
            prompt: targetArg,
        };
        return jsonResponse(resp, "switched");
    }
    return handleRunStreaming(child, resolvedId, targetArg, sessionKey);
}
function handleRunStreaming(child, runId, prompt, sessionKey) {
    return new Promise((resolve) => {
        const lines = [];
        lines.push(`🚀 CUA 任务已启动\n\nTask ID: ${runId}\nPrompt: ${prompt}\n`);
        let lastStepCount = 0;
        const runsDir = currentTask?.runsDir || RUNS_BASE_DIR;
        const jsonlPath = path.join(runsDir, runId, "steps.jsonl");
        const pollTimer = setInterval(() => {
            try {
                if (!fs.existsSync(jsonlPath))
                    return;
                const stepLines = fs
                    .readFileSync(jsonlPath, "utf8")
                    .split("\n")
                    .filter((l) => l.trim());
                if (stepLines.length <= lastStepCount)
                    return;
                for (let i = lastStepCount; i < stepLines.length; i++) {
                    try {
                        const step = JSON.parse(stepLines[i]);
                        const rationale = extractRationale(step);
                        if (rationale) {
                            lines.push(`✅ ${rationale}`);
                        }
                    }
                    catch (_) { }
                }
                lastStepCount = stepLines.length;
            }
            catch (_) { }
        }, 500);
        const onExit = (_code) => {
            clearInterval(pollTimer);
            child.removeListener("exit", onExit);
            const diskResult = readStepsFromDisk(runId, runsDir);
            let finalStatus = "FAILED" /* TaskStatus.FAILED */;
            let reason = null;
            let durationMs = null;
            let totalTokens = null;
            if (currentTask?.isInterrupted) {
                finalStatus = "INTERRUPTED" /* TaskStatus.INTERRUPTED */;
                reason = currentTask.interruptReason || null;
                saveTaskState({
                    type: "interrupted",
                    runId,
                    prompt,
                    runsDir: currentTask?.runsDir,
                    interruptReason: reason || "",
                    startTime: new Date(currentTask?.startTime || Date.now()).toISOString(),
                });
            }
            else if (diskResult?.finalStatus) {
                finalStatus = diskResult.finalStatus;
                reason = diskResult.finalReason || null;
            }
            if (diskResult?.durationMs)
                durationMs = diskResult.durationMs;
            else if (currentTask)
                durationMs = Date.now() - currentTask.startTime;
            if (diskResult?.totalTokens)
                totalTokens = diskResult.totalTokens;
            const durationSec = durationMs != null ? `${Math.floor(durationMs / 1000)}s` : "-";
            const tokensStr = totalTokens != null ? `${totalTokens}` : "-";
            lines.push("");
            if (finalStatus === "SUCCESS" /* TaskStatus.SUCCESS */) {
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push("✅ 任务执行完成");
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push(`  Task ID:  ${runId}`);
                lines.push(`  耗时:     ${durationSec}`);
                lines.push(`  Tokens:   ${tokensStr}`);
                if (reason)
                    lines.push(`  结果:     ${reason}`);
            }
            else if (finalStatus === "INTERRUPTED" /* TaskStatus.INTERRUPTED */) {
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push("⏸️ 任务已暂停，需要人工介入");
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push(`  Task ID:  ${runId}`);
                lines.push(`  耗时:     ${durationSec}`);
                lines.push(`  原因:     ${reason || "需要用户手动操作"}`);
                // Prep legacy IM-handoff screenshot at a fixed diagnostic path. IM send
                // uses llm_output intent-driven fresh capture, not this fixed file.
                if (sessionKey) {
                    markHandoffSource(sessionKey, "cua");
                }
                const handoffPath = prepImHandoffScreenshot();
                if (handoffPath) {
                    lines.push(`  截图:     ${handoffPath}`);
                }
                lines.push("");
                lines.push("💡 完成操作后，使用 /cua continue 继续任务");
            }
            else {
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push("❌ 任务执行失败");
                lines.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
                lines.push(`  Task ID:  ${runId}`);
                lines.push(`  耗时:     ${durationSec}`);
                lines.push(`  原因:     ${reason || "未知错误"}`);
            }
            if (finalStatus !== "INTERRUPTED" /* TaskStatus.INTERRUPTED */ &&
                currentTask?.process === child) {
                currentTask.process = undefined;
            }
            resolve({ text: lines.join("\n"), type: "switched" });
        };
        child.on("exit", onExit);
    });
}
function readStepsFromDisk(taskId, runsDir) {
    const baseDir = runsDir || RUNS_BASE_DIR;
    const tryReadDir = (dirPath) => {
        let result = null;
        const jsonlPath = path.join(dirPath, "steps.jsonl");
        const jsonPath = path.join(dirPath, "steps.json");
        const metaPath = path.join(dirPath, "run.meta.json");
        const jsonlResult = parseStepsJsonl(jsonlPath);
        if (jsonlResult.rationales.length > 0 || jsonlResult.finalStatus) {
            result = jsonlResult;
        }
        if (!result) {
            const jsonResult = parseStepsJson(jsonPath);
            if (jsonResult.rationales.length > 0 || jsonResult.finalStatus) {
                result = jsonResult;
            }
        }
        const hasStepsFile = fs.existsSync(jsonlPath) || fs.existsSync(jsonPath);
        if (!result && !hasStepsFile)
            return null;
        if (!result)
            result = { rationales: [], steps: [] };
        const meta = readJsonFile(metaPath);
        if (meta?.startMs) {
            if (!result.startTime)
                result.startTime = new Date(meta.startMs).toISOString();
            if (!result.durationMs)
                result.durationMs = Date.now() - meta.startMs;
        }
        const stepsJson = readJsonFile(jsonPath);
        if (stepsJson && !result.startTime) {
            if (stepsJson.start)
                result.startTime = stepsJson.start;
            if (stepsJson.durationMs)
                result.durationMs = stepsJson.durationMs;
            if (stepsJson.llm?.usage?.totalTokens)
                result.totalTokens = stepsJson.llm.usage.totalTokens;
        }
        return result;
    };
    if (taskId && taskId !== "pending") {
        const targetDir = path.join(baseDir, taskId);
        if (fs.existsSync(targetDir)) {
            const result = tryReadDir(targetDir);
            if (result)
                return result;
        }
        if (baseDir !== RUNS_BASE_DIR) {
            const fallbackDir = path.join(RUNS_BASE_DIR, taskId);
            if (fs.existsSync(fallbackDir)) {
                const result = tryReadDir(fallbackDir);
                if (result)
                    return result;
            }
        }
    }
    const latestRunDir = getLatestRunDir();
    if (latestRunDir) {
        const result = tryReadDir(latestRunDir);
        if (result)
            return result;
    }
    return null;
}
function queryHistoricalStatus(runId) {
    const runsDir = currentTask?.runsDir || RUNS_BASE_DIR;
    const diskResult = readStepsFromDisk(runId, runsDir);
    if (!diskResult) {
        const resp = {
            error: "task_not_found",
            detail: `No task found with ID "${runId}"`,
        };
        return jsonResponse(resp, "error");
    }
    let prompt = "";
    const stepsJson = readJsonFile(path.join(runsDir, runId, "steps.json"));
    if (stepsJson?.task)
        prompt = stepsJson.task;
    const status = diskResult.finalStatus || "UNKNOWN" /* TaskStatus.UNKNOWN */;
    const resp = {
        runId,
        status,
        prompt,
        startTime: diskResult.startTime || null,
        durationMs: diskResult.durationMs || null,
        reason: diskResult.finalReason || null,
        steps: diskResult.steps || [],
    };
    return jsonResponse(resp, "list");
}
async function handleStatusCommand(targetArg) {
    checkAndSyncTaskState();
    if (!currentTask) {
        const resp = {
            runId: "",
            status: "IDLE" /* TaskStatus.IDLE */,
            prompt: "",
            startTime: null,
            durationMs: null,
            reason: null,
            steps: [],
        };
        return jsonResponse(resp, "list");
    }
    if (targetArg && targetArg !== currentTask.id) {
        return queryHistoricalStatus(targetArg);
    }
    const diskResult = readStepsFromDisk(currentTask.id, currentTask.runsDir);
    const startTime = diskResult?.startTime || new Date(currentTask.startTime).toISOString();
    const durationMs = diskResult?.durationMs ?? Date.now() - currentTask.startTime;
    let status = "RUNNING" /* TaskStatus.RUNNING */;
    let reason = null;
    let handoff = false;
    if (currentTask.isInterrupted) {
        status = "INTERRUPTED" /* TaskStatus.INTERRUPTED */;
        reason = currentTask.interruptReason || null;
        handoff = true;
        const existingState = loadTaskState();
        if (!existingState || existingState.type !== "interrupted") {
            saveTaskState({
                type: "interrupted",
                runId: currentTask.id,
                prompt: currentTask.prompt,
                runsDir: currentTask.runsDir,
                interruptReason: currentTask.interruptReason || "",
                stepsCount: currentTask.historySteps?.length || 0,
                startTime: new Date(currentTask.startTime).toISOString(),
            });
        }
    }
    else if (diskResult?.finalStatus === "INTERRUPTED" /* TaskStatus.INTERRUPTED */) {
        status = "INTERRUPTED" /* TaskStatus.INTERRUPTED */;
        reason = diskResult.finalReason || null;
        handoff = true;
        currentTask.isInterrupted = true;
        currentTask.interruptReason = diskResult.finalReason;
        saveTaskState({
            type: "interrupted",
            runId: currentTask.id,
            prompt: currentTask.prompt,
            runsDir: currentTask.runsDir,
            interruptReason: diskResult.finalReason || "",
            stepsCount: diskResult.rationales.length,
            startTime: new Date(currentTask.startTime).toISOString(),
        });
    }
    else if (diskResult?.finalStatus === "FAILED" /* TaskStatus.FAILED */) {
        status = "FAILED" /* TaskStatus.FAILED */;
        reason = diskResult.finalReason || null;
    }
    else if (diskResult?.finalStatus === "SUCCESS" /* TaskStatus.SUCCESS */) {
        status = "SUCCESS" /* TaskStatus.SUCCESS */;
        reason = diskResult.finalReason || null;
    }
    else if (isCuaProcessRunning()) {
        status = "RUNNING" /* TaskStatus.RUNNING */;
    }
    const steps = diskResult?.steps && diskResult.steps.length > 0
        ? diskResult.steps
        : buildStepsFromHistory(currentTask.historySteps || []);
    const resp = {
        runId: currentTask.id,
        status,
        prompt: currentTask.prompt,
        startTime,
        durationMs,
        reason,
        steps,
        ...(handoff ? { handoff: true } : {}),
    };
    return jsonResponse(resp, "list");
}
function buildStepsFromHistory(historySteps) {
    const result = [];
    let idx = 0;
    for (const step of historySteps) {
        if (step.type === "action" || step.type === "step") {
            idx++;
            result.push({
                step: idx,
                rationale: extractRationale(step),
                actionName: step.actionName ?? null,
                success: step.success ?? null,
            });
        }
        else if (step.type === "done") {
            result.push({
                step: idx + 1,
                rationale: step.success === "interrupted" || step.brain?.should_wait_for_user
                    ? `⏸️ 任务已暂停: ${step.reason || "needs_user"}`
                    : step.success === false || step.error
                        ? `❌ 任务失败: ${step.reason || step.error || "未知错误"}`
                        : `✅ 任务完成`,
                actionName: null,
                success: step.success ?? null,
            });
        }
    }
    return result;
}
async function handleStopCommand(targetArg) {
    checkAndSyncTaskState();
    if (!currentTask) {
        const resp = {
            runId: "",
            status: "ERROR" /* TaskStatus.ERROR */,
            message: "No CUA task is currently active to stop.",
        };
        return jsonResponse(resp, "error");
    }
    if (targetArg && targetArg !== currentTask.id) {
        const resp = {
            runId: targetArg,
            status: "ERROR" /* TaskStatus.ERROR */,
            message: `Provided ID "${targetArg}" does not match current task ID "${currentTask.id}".`,
        };
        return jsonResponse(resp, "error");
    }
    const stoppedId = currentTask.id;
    saveTaskState({
        type: "stopped",
        runId: currentTask.id,
        prompt: currentTask.prompt,
        runsDir: currentTask.runsDir,
        stoppedAt: new Date().toISOString(),
    });
    if (currentTask.process?.pid) {
        killProcessTree(currentTask.process.pid, stoppedId);
    }
    else {
        const state = loadTaskState();
        if (state?.pid) {
            try {
                process.kill(state.pid, "SIGTERM");
            }
            catch (_) { }
        }
    }
    currentTask = null;
    const resp = {
        runId: stoppedId,
        status: "STOPPED" /* TaskStatus.STOPPED */,
    };
    return jsonResponse(resp, "cleared");
}
function findLatestInterruptedTask() {
    const runsDir = currentTask?.runsDir || RUNS_BASE_DIR;
    const dirs = listRunDirs(runsDir);
    for (const { runId, dirPath } of dirs) {
        const stepsJson = readJsonFile(path.join(dirPath, "steps.json"));
        if (stepsJson?.success === "interrupted") {
            return {
                runId,
                prompt: stepsJson.task || "",
                runsDir: runsDir,
                interruptReason: stepsJson.reason,
            };
        }
    }
    return null;
}
async function handleContinueCommand(targetArg, sessionKey) {
    checkAndSyncTaskState();
    if (currentTask?.process) {
        const resp = {
            runId: currentTask.id,
            status: "ERROR" /* TaskStatus.ERROR */,
            message: "A CUA task is currently running. Cannot continue another task.",
        };
        return jsonResponse(resp, "error");
    }
    if (currentTask?.isInterrupted) {
        return handleContinueInterrupted(targetArg, sessionKey);
    }
    const state = loadTaskState();
    if (state?.type === "stopped") {
        return handleContinueStopped(state, targetArg, sessionKey);
    }
    if (state?.type === "interrupted") {
        syncTaskStateFromDisk();
        if (currentTask?.isInterrupted) {
            return handleContinueInterrupted(targetArg, sessionKey);
        }
    }
    const interruptedTask = findLatestInterruptedTask();
    if (interruptedTask) {
        logToFile(`[Continue] Found interrupted task from runs dir: ${interruptedTask.runId}, prompt: "${interruptedTask.prompt}"`);
        currentTask = {
            id: interruptedTask.runId,
            prompt: interruptedTask.prompt,
            startTime: Date.now(),
            isInterrupted: true,
            interruptReason: interruptedTask.interruptReason,
            runsDir: interruptedTask.runsDir,
            historySteps: [],
        };
        return handleContinueInterrupted(targetArg, sessionKey);
    }
    const resp = {
        runId: "",
        status: "ERROR" /* TaskStatus.ERROR */,
        message: "No task found to continue. Use /cua run to start a new task.",
    };
    return jsonResponse(resp, "error");
}
async function handleContinueInterrupted(targetArg, sessionKey) {
    const oldRunId = currentTask.id;
    const originalPrompt = currentTask.prompt;
    const state = loadTaskState();
    const oldPid = currentTask.process?.pid || state?.pid;
    const alive = oldPid && isProcessAlive(oldPid);
    if (alive) {
        currentTask.isInterrupted = false;
        clearTaskState();
        logToFile(`[Continue] Original process (pid ${oldPid}) is alive, it will resume automatically`);
        const resp = {
            runId: oldRunId,
            status: "RESUMED" /* TaskStatus.RESUMED */,
            message: "Original process is alive, will resume automatically.",
        };
        return jsonResponse(resp, "switched");
    }
    logToFile(`[Continue] Original process is dead, restarting CUA with enhanced prompt`);
    const diskResult = readStepsFromDisk(oldRunId, currentTask.runsDir);
    const interruptReason = resolveInterruptReason(currentTask, diskResult);
    const enhancedPrompt = buildResumePrompt(originalPrompt, interruptReason, targetArg);
    logToFile(`[Continue] Enhanced prompt: ${enhancedPrompt}`);
    const child = spawnCuaProcess(enhancedPrompt, sessionKey);
    clearTaskState();
    currentTask = {
        id: "pending",
        prompt: originalPrompt,
        startTime: Date.now(),
        process: child,
        latestStepInfo: null,
        historySteps: [],
        isInterrupted: false,
    };
    await waitForRunId();
    const newRunId = currentTask?.id ?? "pending";
    const resp = {
        runId: newRunId,
        status: "RESTARTED" /* TaskStatus.RESTARTED */,
        message: `Old runId: ${oldRunId}`,
    };
    return jsonResponse(resp, "switched");
}
async function handleContinueStopped(state, _targetArg, sessionKey) {
    clearTaskState();
    logToFile(`[Continue] Restarting stopped task: ${state.runId}, prompt: "${state.prompt}"`);
    const child = spawnCuaProcess(state.prompt, sessionKey);
    currentTask = {
        id: "pending",
        prompt: state.prompt,
        startTime: Date.now(),
        process: child,
        latestStepInfo: null,
        historySteps: [],
        isInterrupted: false,
        runsDir: state.runsDir,
    };
    await waitForRunId();
    const newRunId = currentTask?.id ?? "pending";
    const resp = {
        runId: newRunId,
        status: "RESTARTED" /* TaskStatus.RESTARTED */,
        message: `Old runId: ${state.runId}`,
    };
    return jsonResponse(resp, "switched");
}
function handleListCommand() {
    const runsDir = currentTask?.runsDir || RUNS_BASE_DIR;
    let dirs = listRunDirs(runsDir);
    if (!dirs || dirs.length === 0) {
        if (runsDir !== RUNS_BASE_DIR) {
            const fallbackDirs = listRunDirs(RUNS_BASE_DIR);
            if (fallbackDirs && fallbackDirs.length > 0) {
                dirs = fallbackDirs;
            }
        }
    }
    const tasks = dirs.map(({ runId, dirPath }) => readRunListItem(dirPath, runId));
    const resp = { tasks };
    return jsonResponse(resp, "list");
}
function listRunDirs(runsDir) {
    try {
        if (!fs.existsSync(runsDir))
            return [];
        return fs
            .readdirSync(runsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !IGNORED_DIRS.has(d.name))
            .map((d) => {
            const fullPath = path.join(runsDir, d.name);
            return {
                runId: d.name,
                dirPath: fullPath,
                mtime: fs.statSync(fullPath).mtimeMs,
            };
        })
            .sort((a, b) => b.mtime - a.mtime);
    }
    catch (_) {
        return [];
    }
}
function readRunListItem(dirPath, runId) {
    const item = {
        runId,
        status: "UNKNOWN" /* TaskStatus.UNKNOWN */,
        prompt: null,
        startTime: null,
        durationMs: null,
        totalTokens: null,
    };
    const stepsJson = readJsonFile(path.join(dirPath, "steps.json"));
    if (stepsJson) {
        if (stepsJson.success === true)
            item.status = "SUCCESS" /* TaskStatus.SUCCESS */;
        else if (stepsJson.success === false)
            item.status = "FAILED" /* TaskStatus.FAILED */;
        else if (stepsJson.success === "interrupted")
            item.status = "INTERRUPTED" /* TaskStatus.INTERRUPTED */;
        item.prompt = stepsJson.task || null;
        item.startTime = stepsJson.start || null;
        item.durationMs = stepsJson.durationMs ?? null;
        item.totalTokens = stepsJson.llm?.usage?.totalTokens ?? null;
        return item;
    }
    const meta = readJsonFile(path.join(dirPath, "run.meta.json"));
    if (meta) {
        if (meta.state === "running") {
            item.status =
                typeof meta.pid === "number" && isProcessAlive(meta.pid)
                    ? "RUNNING" /* TaskStatus.RUNNING */
                    : "CRASHED" /* TaskStatus.CRASHED */;
        }
        if (meta.startMs) {
            item.startTime = new Date(meta.startMs).toISOString();
            item.durationMs = Date.now() - meta.startMs;
        }
    }
    if (item.status === "UNKNOWN" /* TaskStatus.UNKNOWN */ &&
        fs.existsSync(path.join(dirPath, "steps.jsonl"))) {
        item.status = "RUNNING" /* TaskStatus.RUNNING */;
    }
    return item;
}
function handleUnknownCommand(subCommand) {
    const resp = {
        error: "unknown_command",
        detail: `Unknown CUA command: "${subCommand}". Type /cua for help.`,
    };
    return jsonResponse(resp, "error");
}
//# sourceMappingURL=cua_commands.js.map