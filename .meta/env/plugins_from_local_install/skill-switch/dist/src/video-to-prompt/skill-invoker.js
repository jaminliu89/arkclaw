import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { findSkillById, resolveAgentSkillsDir, scanSkillsFromDirectories, } from "../skill-discovery.js";
import { resolveWorkspaceDir } from "./workspace.js";
// R4 tsW7: defense-in-depth — even though current callers (commands.ts /
// analysis-lifecycle.ts) pre-validate skillScriptPath via validateSkillScriptPath,
// any future caller that forgets must not be able to spawn arbitrary scripts.
// We re-assert path.isAbsolute + reject "..", "//" segments inline (inlined to
// avoid the cyclic import on commands.ts).
function assertAbsoluteNoTraversal(p) {
    if (!path.isAbsolute(p)) {
        throw new Error(`skill-invoker: skillScriptPath must be absolute (got: ${p})`);
    }
    const resolved = path.resolve(p);
    if (resolved === path.sep) {
        throw new Error(`skill-invoker: skillScriptPath must not be the filesystem root`);
    }
    if (resolved !== p) {
        // Caller passed a path containing ../ or // — refuse to second-guess.
        throw new Error(`skill-invoker: skillScriptPath must be already-resolved (got: ${p}, resolved: ${resolved})`);
    }
}
export async function invokeVideoToPromptSkill(opts) {
    // R4 tsW7: refuse to spawn unsafe paths even if caller forgot.
    assertAbsoluteNoTraversal(opts.skillScriptPath);
    // R6 DiD-2: same defense for videoPath (becomes skill subprocess argv).
    assertAbsoluteNoTraversal(opts.videoPath);
    if (opts.allowedVideoRoot) {
        // gemini review: realpath 收口 —— path.resolve 只做词法规整,videoPath
        // 中段含 symlink 时前缀比对可绕(symlink 指向 allowedVideoRoot 外仍
        // 通过)。realpath 解析符号链接后再比对;realpath 失败(ENOENT 等)
        // 直接抛 → 拒绝 spawn(R6 DiD-2 防御层收口)。
        const root = await fs.realpath(path.resolve(opts.allowedVideoRoot));
        const v = await fs.realpath(path.resolve(opts.videoPath));
        if (v !== root && !v.startsWith(root + path.sep)) {
            throw new Error(`skill-invoker: videoPath ${v} is outside allowed root ${root}`);
        }
    }
    await fs.mkdir(opts.promptDir, { recursive: true });
    // ADR-0028 (2026-05-21 amended): 此 per-run 文件是「事件协议流」—— 子进程
    // stdout 的 JSON 事件被 arkclawVtpRecording.events RPC 读取回放给前端,
    // 属 IPC / per-run 数据,**不是诊断日志**;随 runs/<rid>/ 被 pruneOldRecordings
    // 按 recordingRetentionDays 整目录清。文件名从 skill.log 改为 events.jsonl 以反映
    // 本质(skill.log 这个名字已淘汰)。诊断日志走 vtpLog → /var/log/.../vtp.log。
    const logPath = path.join(opts.promptDir, "events.jsonl");
    const logFd = await fs.open(logPath, "a");
    const stream = logFd.createWriteStream();
    const env = {
        ...process.env,
        CUA_VTP_RECORDING_ID: opts.recordingId,
        CUA_VTP_OUTPUT_DIR: opts.promptDir,
        CUA_VTP_OUTPUT_ROOT: path.dirname(path.dirname(opts.promptDir)),
        // 二期 UX 评审 supersede (spec vtp-video-preview L404):本地 mp4 MUST
        // 保留 7 天 — 不再在 succeeded 时立即删除。原 ADR-0025 "succeeded 立即
        // 删本地" 被推翻;cleanup-scheduler 二期 pruneOldRecordings (d2f4770)
        // 按 recordingRetentionDays 默认 7 天兜底清。一期硬编码 "true" 是遗留,二期
        // 改为 "false" 让 saveVideoToMount 等需访问本地 mp4 的 RPC 在 analyze
        // 后仍能 lstat 源文件 + 拷贝到挂载点。
        CUA_VTP_DELETE_VIDEO_ON_SUCCESS: "false",
        ...(opts.extraEnv ?? {}),
    };
    // 二期 P4: plugin 端已接入 OTel(gateway.ts initOtel("plugin") +
    // observability/{otel,metrics,tracer}.ts)。仍延后的只是 plugin → runtime
    // SEA 的 traceparent 跨进程传播 —— 当前 plugin 与 runtime SEA 的 trace
    // 各自独立,未串成一条。后续若 host 把 traceparent 注入 plugin process
    // env(TRACEPARENT / HTTP_TRACEPARENT),plugin 直接转发到 VTP_TRACEPARENT
    // env,runtime SEA 那边的 OTel 会 propagation.extract 接上父 span。
    if (process.env.TRACEPARENT)
        env.VTP_TRACEPARENT = process.env.TRACEPARENT;
    if (process.env.HTTP_TRACEPARENT)
        env.VTP_TRACEPARENT = process.env.HTTP_TRACEPARENT;
    const child = spawn("bash", [opts.skillScriptPath, opts.videoPath], {
        detached: true,
        stdio: ["ignore", stream, stream],
        env,
        cwd: path.dirname(opts.skillScriptPath),
    });
    child.unref();
    if (!child.pid) {
        // R4 C-④: end the stream rather than closing logFd directly (avoids
        // EBADF window; stream owns the fd after createWriteStream).
        await new Promise((resolve) => {
            try {
                stream.end(() => resolve());
            }
            catch {
                resolve();
            }
        });
        throw new Error("skill spawn failed: no pid assigned");
    }
    // R4 C-④: WriteStream owns the fd once createWriteStream() wraps it.
    // Calling logFd.close() while the stream still has buffered writes triggers
    // EBADF on the next stream.write. Use stream.end(cb) which flushes then
    // closes the fd. closeStreamOnce stays atomic via flag.
    let streamClosed = false;
    const closeStreamOnce = () => new Promise((resolve) => {
        if (streamClosed) {
            resolve();
            return;
        }
        streamClosed = true;
        try {
            stream.end(() => resolve());
        }
        catch {
            resolve();
        }
    });
    // gemini-B: one-shot guard —— Node 对 spawn 错误可能同时 fire `error` 和
    // `exit`(`once` 只保证单事件一次,不保证两事件互斥),否则 onExit
    // watchdog 会跑两遍。watchdog 本身大体幂等,但双触发仍是冗余 patch +
    // 双计 metric;用一次性 flag 收口为恰好一次。
    let onExitFired = false;
    child.once("exit", (code, signal) => {
        closeStreamOnce().catch(() => { });
        if (opts.onExit && !onExitFired) {
            onExitFired = true;
            // R8 M3: 1-shot retry for onExit (typically the watchdog patching
            // recording status=failed). state.json lock contention can transiently
            // throw; without retry the recording stays stuck in `analyzing` until
            // reconcileOnStartup catches it on next plugin restart. Retry after
            // 500ms (well under LOCK_ACQUIRE_TIMEOUT_MS=15s).
            void runOnExitWithRetry(opts.onExit, code, signal);
        }
    });
    child.once("error", () => {
        closeStreamOnce().catch(() => { });
        if (opts.onExit && !onExitFired) {
            onExitFired = true;
            // R9 Warn-Ⓒ: spawn-time error (ENOENT/EACCES) path — also go through
            // runOnExitWithRetry for symmetry with the exit-event branch (R8 M3).
            // spawn error usually fires together with exit but Node doesn't
            // guarantee both; without retry here the watchdog can fail silently.
            void runOnExitWithRetry(opts.onExit, 1, null);
        }
    });
    return { pid: child.pid, logPath };
}
// R8 M3: best-effort 1-shot retry for onExit callbacks. Watchdog uses
// patchRecording which goes through state.json file lock; transient lock
// contention during a hot moment (multiple skills exiting in same second)
// could throw. Retry after 500ms before giving up. Failures still swallowed
// — reconcileOnStartup is the final safety net on next plugin restart.
async function runOnExitWithRetry(onExit, code, signal) {
    try {
        await Promise.resolve(onExit(code, signal));
        return;
    }
    catch {
        // first attempt failed — fall through to retry
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
        await Promise.resolve(onExit(code, signal));
    }
    catch {
        // still failed — silently swallow; reconcileOnStartup will recover
        // on next plugin restart.
    }
}
const VIDEO_TO_PROMPT_SKILL_ID = "video-to-prompt";
// 录制分析要 spawn 的 skill 脚本路径。不再写死 base 目录,而是经 skill-discovery
// 动态定位 video-to-prompt skill 的实际安装目录(扫描 managed / <workspace>/skills
// / <workspace>/.agents/skills / <HOME>/.agents/skills / extraDirs,与 skill
// list/switch 同源),命中则相对其 SKILL.md 拼 scripts/video-to-prompt.sh ——
// 安装目录迁移也自动跟上。discovery 未命中时回退到当前安装根 <HOME>/.agents/
// skills(install/upgrade 脚本落点),不再回退已被 prune 的旧 <workspace>/skills。
export function resolveDefaultSkillScriptPath(api) {
    try {
        const skills = scanSkillsFromDirectories({
            stateDir: api.runtime.state.resolveStateDir(),
            workspaceDir: resolveWorkspaceDir(api),
            config: api.config,
        });
        const vtp = findSkillById(skills, VIDEO_TO_PROMPT_SKILL_ID);
        if (vtp) {
            return path.join(path.dirname(vtp.path), "scripts", "video-to-prompt.sh");
        }
    }
    catch (err) {
        // discovery 失败不致命,落到下方 <HOME>/.agents/skills 兜底。留一条 debug,
        // 便于线上 misconfig 复发时定位(coco F3),不静默吞错。
        api.logger?.debug?.(`resolveDefaultSkillScriptPath: skill discovery failed, falling back to <HOME>/.agents/skills: ${err instanceof Error ? err.message : String(err)}`);
    }
    return path.join(resolveAgentSkillsDir(), VIDEO_TO_PROMPT_SKILL_ID, "scripts", "video-to-prompt.sh");
}
//# sourceMappingURL=skill-invoker.js.map