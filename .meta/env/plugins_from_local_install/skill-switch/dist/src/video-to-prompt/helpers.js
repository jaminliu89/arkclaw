// Shared helpers used by every lifecycle handler. Extracted from commands.ts
// so analysis-lifecycle / skill-persistence / cleanup-scheduler
// (and the new recording-lifecycle) no longer import back into commands.ts —
// breaking the circular import that R4 tsW2 flagged.
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { resolveAgentSkillsDir, scanSkillsFromDirectories, } from "../skill-discovery.js";
import { resolveWorkspaceDir } from "./workspace.js";
// R12 P3-②: circular import with recording-state.ts is intentional and safe
// — recording-state.ts imports `ACTIVE_STATUSES` (line 17) from this file,
// while this file imports `patchRecording` from recording-state.ts. Both
// sides only access the imported binding inside async function bodies
// (patchRecording usage at lines 118, 137 below; ACTIVE_STATUSES usage in
// recording-state's reconcileOnStartupInner). ESM live-bindings resolve at
// access time, not at import time. Future refactors must preserve this
// invariant — moving ACTIVE_STATUSES to a top-level const that depends on
// recording-state-side state would break it.
import { deriveStatusFromMetaTransition, getRecording, patchRecordingIfStatus, } from "./recording-state.js";
import { incrementCounter, recordHistogram } from "./observability/metrics.js";
import { vtpLog } from "./observability/logger.js";
import { withCommandSpan } from "./observability/tracer.js";
// ── atomic file write (fsync-guaranteed) ──────────────────────────────────
// R8 Warn-② / R-Santa W8: shared atomic write helper extracted from 4 inline
// copies (skill-persistence / recording-index / result-reader / recording-
// state). Mirrors runtime artifacts R6 H7 pattern: open → writeFile →
// fsync → close → rename. fsync BEFORE rename so power-loss/SIGKILL between
// write and rename can't leave a renamed-but-empty target.
//
// Caller supplies the final `target` path; intermediate `${target}.tmp` is
// derived and cleaned up on failure. Caller is responsible for ensuring the
// parent dir exists (we don't fs.mkdir here — that's a separate decision the
// caller often wants to skip on hot paths).
export async function atomicWriteFileWithSync(target, data) {
    // R-Round-N M2: per-call unique tmp path. Old `${target}.tmp` was a constant
    // for a given target → two concurrent writers race the same tmp path:
    // writer A opens, writer B opens (truncates), A's data overwrites B's
    // header, rename leaves a corrupt blend. PID + 8-hex nonce gives ~2^48 of
    // collision space, fully eliminating the same-target race. fsync + rename
    // semantics unchanged.
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    // review 2026-05-25 #1 (security hardening — align with runtime
    // atomicWriteFile A.2): numeric open flags + 0o600 mode replace the
    // permissive "w" string flag. The nonce above lowers collision /
    // guess probability, but only O_EXCL converts that into a hard
    // boundary (existing tmp ⇒ fail-fast) and only O_NOFOLLOW refuses a
    // pre-positioned symlink at the tmp path. O_NOFOLLOW is 0 on Windows
    // — production targets Linux/macOS, so the bit is effective there.
    const nofollow = fsConstants.O_NOFOLLOW ?? 0;
    let fh;
    try {
        fh = await fs.open(tmp, fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            nofollow, 0o600);
        await fh.writeFile(data, { encoding: "utf8" });
        await fh.sync();
    }
    catch (err) {
        if (fh)
            await fh.close().catch(() => { });
        try {
            await fs.unlink(tmp);
        }
        catch {
            /* ignore */
        }
        throw err;
    }
    // R-Round-N M8 (a): close failure should abort the rename, not be swallowed.
    // On NFS / filesystems with delayed-write errors, a failed close can mean
    // the data never reached the disk; previously this was silently dropped via
    // .catch(() => {}) and the rename proceeded as if write succeeded.
    try {
        if (fh)
            await fh.close();
    }
    catch (err) {
        try {
            await fs.unlink(tmp);
        }
        catch {
            /* ignore */
        }
        throw err;
    }
    try {
        await fs.rename(tmp, target);
    }
    catch (err) {
        try {
            await fs.unlink(tmp);
        }
        catch {
            /* ignore */
        }
        throw err;
    }
    // R-Round-N M8 (b): POSIX rename durability requires fsync of the parent
    // directory — without it, a power-loss/SIGKILL between this rename and the
    // next write could expose a stale dirent (target visible but pointing at a
    // truncated inode). Best-effort: some filesystems (tmpfs / FAT) reject
    // O_RDONLY open of a directory or no-op fsync; in that case we accept the
    // weaker durability rather than throw, since the data file itself is
    // already fsync'd above.
    let dirFh;
    try {
        dirFh = await fs.open(path.dirname(target), "r");
        await dirFh.sync();
    }
    catch {
        // parent fsync unsupported / unavailable — accept best-effort durability
    }
    finally {
        if (dirFh)
            await dirFh.close().catch(() => { });
    }
}
// ── recording defaults ──────────────────────────────────────────────────────
export const DEFAULT_MAX_SECONDS = 120;
export const DEFAULT_GRACE_SECONDS = 10;
export const DEFAULT_FFMPEG = "ffmpeg";
export const DEFAULT_DISPLAY = ":99";
export const DEFAULT_RESOLUTION = "1920x1080";
export const DEFAULT_FRAMERATE = 15;
// R-Round-N H4-a: maxSizeMB lives in the same accessor as the rest of the
// recording knobs so callers don't have to choose between pluginConfig() and
// hand-rolled api.config drilling. Mirrors openclaw.plugin.json default.
export const DEFAULT_MAX_SIZE_MB = 300;
// R10 Critical-①: shared "active / non-terminal" status set. Recording in any
// of these states still owns ffmpeg or skill resources; spawning a new ffmpeg
// without first stopping/canceling would leak the existing one (paused = SIGSTOP
// frozen but alive; analyzing = skill subprocess holding promptDir). Used by
// gateway.ts (RPC-side resumedFromExisting branch) AND recording-lifecycle.ts
// (slash-command handleStartInner guard) — must agree.
//
// ── status-subset taxonomy (L-18 note) ───────────────────────────────────
// Three RecordingMetadata.status subsets exist in this codebase, each with
// distinct semantics. When adding a new RPC, decide which one applies AND
// reuse the existing constant / selector instead of inlining a new filter —
// drift between callsites is what L-18 documents.
//
//   ACTIVE_STATUSES               = {recording, paused, analyzing}
//     "ffmpeg or skill subprocess may still be alive". Used by
//     reconcileOnStartup to sweep crashed processes and by the
//     slash-command handleStart inner guard (combined with
//     isProcessAlive(ffmpegPid)). Does NOT gate start RPC by itself —
//     lifecycle clears activeRecordingId on stop→analyzing, so a single
//     activeRecordingId check would miss analyzing tasks. Start RPC uses
//     the `in-flight-task` selector below instead.
//
//   resumable-stopped selector    = {stopped} ∧ videoExists on disk
//     (see recording-state.ts → pickDefaultRecording) "outstanding stopped
//     work the user can resume into analyze"; gates status RPC fallback
//     and CLI handleStatus. Narrower than the active-status set because
//     succeeded/failed/canceled are archived from the user's POV.
//
//   in-flight-task selector       = {recording, paused, analyzing} ∪
//                                   ({stopped} ∧ videoExists)
//     (see recording-state.ts → pickDefaultRecording) "non-terminal task
//     blocking a new start"; gates start RPC. Enforces the
//     single-task-at-a-time contract: a task ends only on succeeded /
//     failed / canceled (the three terminal statuses).
//
// Do not collapse these into one set — each captures a different question
// ("which processes might still be alive?" vs "what's on the user's plate?"
// vs "what stopped recording can I resume?" vs "can I start a new task?").
export const ACTIVE_STATUSES = new Set(["recording", "paused", "analyzing"]);
// ── skillScriptPath allowlist ────────────────────────────────────────────
// CLAUDE.md: "plugin and gateway run in the same process" → arbitrary bash exec
// from any RPC caller is a host-takeover vector. Lock skillScriptPath inside an
// explicit allowlist. allowlist 与 resolveDefaultSkillScriptPath 用同一份
// skill-discovery 结果反推,从根上杜绝「discovery 改了、spawn/allowlist 没跟上」
// 的 drift(本次 ENOENT bug 即此模式):
//   1. <HOME>/.agents/skills/   (无条件;discovery 未命中时的 fallback 兜底根)
//   2. 每个 discovery 实际发现到的 skill 的安装根 (只放行真实发现的根,
//      不无脑放宽到所有理论目录)
// Validation flow: must be absolute → path.resolve (collapses ../ traversal)
// → must startsWith one of the resolved allowlist roots (with trailing-sep guard).
/** @internal exported for unit tests */
export function resolveSkillScriptRoots(api) {
    // C 去耦合:workspace 内部经 resolveWorkspaceDir(api) 取,与
    // resolveDefaultSkillScriptPath 同源,消除「caller 传不同 workspace 致 default
    // 路径落在 allowlist 外」的隐式契约(coco F-3)。
    const workspace = resolveWorkspaceDir(api);
    // R7 W5: path.resolve 每个根 —— validateSkillScriptPath 也 resolve candidate,
    // 两侧都必须 absolute 才能做有意义的 prefix 前缀匹配。
    const roots = new Set();
    // fallback 兜底根:resolveDefaultSkillScriptPath discovery 未命中时回退到
    // <HOME>/.agents/skills,该路径必须能过 allowlist 校验,故无条件纳入。
    roots.add(path.resolve(resolveAgentSkillsDir()));
    try {
        const skills = scanSkillsFromDirectories({
            stateDir: api.runtime.state.resolveStateDir(),
            workspaceDir: workspace,
            config: api.config,
        });
        for (const s of skills) {
            // s.path = <root>/<skillId>/SKILL.md → 安装根 = dirname(dirname(path))
            roots.add(path.resolve(path.dirname(path.dirname(s.path))));
        }
    }
    catch (err) {
        // discovery 失败:保留 <HOME>/.agents/skills 兜底根。留一条 debug,便于线上
        // misconfig(如 stateDir 不可读)复发时定位(coco F3),不静默吞错。
        api.logger?.debug?.(`resolveSkillScriptRoots: skill discovery failed, using <HOME>/.agents/skills fallback root only: ${err instanceof Error ? err.message : String(err)}`);
    }
    return Array.from(roots);
}
/** @internal exported for unit tests */
// R-Round-N C2: function is async because we must lstat candidate to refuse
// symlinks AND fs.realpath to resolve any symlinked parent component before
// the allowlist startsWith check. Pure path.resolve() collapses '..' but does
// NOT follow symlinks; an attacker who can drop a symlink under any allowlist
// root (e.g. <HOME>/.agents/skills/<skill>/scripts/x.sh, or a discovered skill
// root) pointing at /tmp/evil.sh would otherwise pass the prefix check
// (resolved path stays inside the allowlist root literally, even though it
// dereferences outside).
// Combined with skill-invoker.ts's spawn(bash, [validated, ...]) call site,
// that is a host-takeover RCE. Both leaf lstat (refuse symlink-as-leaf) and
// parent realpath (refuse symlinked mid-segment) are required.
export async function validateSkillScriptPath(candidate, allowedRoots) {
    if (!path.isAbsolute(candidate)) {
        return {
            ok: false,
            reason: `skillScriptPath must be absolute (got: ${candidate})`,
        };
    }
    // R-Round-N C2 (a) leaf lstat: candidate itself must be a regular file,
    // not a symbolic link. Refusing symlinks at the leaf is the cheapest layer
    // against the "symlink in workspace skill dir" RCE class.
    let stat;
    try {
        stat = await fs.lstat(candidate);
    }
    catch (err) {
        return {
            ok: false,
            reason: `skillScriptPath ${candidate} not accessible: ${err.code ?? String(err)}`,
        };
    }
    if (stat.isSymbolicLink()) {
        return {
            ok: false,
            reason: `skillScriptPath ${candidate} is a symbolic link (refused; defense-in-depth)`,
        };
    }
    if (!stat.isFile()) {
        return {
            ok: false,
            reason: `skillScriptPath ${candidate} is not a regular file`,
        };
    }
    // R-Round-N C2 (b) realpath: resolve any symlinked PARENT component before
    // the allowlist check. path.resolve only collapses '..' lexically; it does
    // not dereference an allowlist root if that segment itself is a symlink.
    // realpath physically dereferences every component, so the resulting path
    // is the real on-disk location used by the kernel for the eventual exec.
    let realCandidate;
    try {
        realCandidate = await fs.realpath(candidate);
    }
    catch (err) {
        return {
            ok: false,
            reason: `skillScriptPath ${candidate} realpath failed: ${err.code ?? String(err)}`,
        };
    }
    // C4: filesystem root '/' as an allowlist entry would match every absolute
    // path (rootSep = '/' → startsWith('/') is true for anything). Reject it
    // here as defense-in-depth even if the schema pattern would already block it.
    for (const root of allowedRoots) {
        // realpath the root too — if the operator configured '/Users/me/skills'
        // as an extra root and that's a symlink, both sides must agree on the
        // physical location for the prefix check to be meaningful.
        let rootResolved;
        try {
            rootResolved = await fs.realpath(root);
        }
        catch {
            // R-review-fix M2: ENOENT root cannot be safely lexicalized. The old
            // path.resolve fallback compared a literal string against the (already
            // realpath'd) candidate — a future symlink planted at the missing
            // path would then implicitly pass the prefix check on the next call.
            // Skip this root entirely; mkdir-ing the path lets the next RPC see it
            // via realpath naturally.
            continue;
        }
        if (rootResolved === path.sep)
            continue;
        const rootSep = rootResolved.endsWith(path.sep)
            ? rootResolved
            : rootResolved + path.sep;
        if (realCandidate === rootResolved || realCandidate.startsWith(rootSep)) {
            return { ok: true, resolved: realCandidate };
        }
    }
    return {
        ok: false,
        reason: `skillScriptPath ${realCandidate} is outside allowed roots: [${allowedRoots.join(", ")}]`,
    };
}
// ── #9 skill exit watchdog ──────────────────────────────────────────────
// handleAnalyze + handleStop(mode=analyze) detach a skill subprocess. If the
// skill exits abnormally (preflight busy, ENOENT, OOM, Ark API down, etc.) and
// never gets to write a terminal status to meta.json, the recording would
// otherwise stay stuck in `analyzing` forever. This callback closes the loop
// by force-patching status=failed when the skill exits non-zero AND meta has
// no terminal status.
export function makeSkillExitWatchdog(api, recordingId, promptDir) {
    // skill 退出 watchdog 是脱离 RPC 的子进程退出回调。用 withCommandSpan
    // (trigger="system") 织入 command span + command.total/duration metric,
    // 与 auto-stop watchdog / scheduler 同机制 — 录制终态(succeeded/failed)
    // 的 patch 链路因此可在 dashboard 上按 command.skillExit 检索。
    return (code, signal) => withCommandSpan("command.skillExit", "system", { "vtp.recording_id": recordingId }, () => runSkillExitWatchdog(api, recordingId, promptDir, code, signal)).catch((err) => {
        api.logger?.error?.(`[video-to-prompt] skill-exit watchdog failed ${recordingId}: ${String(err)}`);
    });
}
/**
 * skill 退出 watchdog 的实际处理逻辑(从 makeSkillExitWatchdog 抽出,使
 * withCommandSpan 能整段包裹)。三分支:
 *   code===0                    → CAS patch succeeded
 *   code!==0 + meta terminal    → CAS via deriveStatusFromMetaTransition
 *   code!==0 + 无 meta terminal → CAS patch failed
 *
 * 所有 terminal 副作用(metric / audit / cleanup mp4)严格 gated on CAS
 * 成功 —— 若 cancel / result-derive / zombie / startup reconcile 已先收敛
 * 这条录制,本 watchdog 是纯 no-op,不重复发射 metric 或清理 mp4。
 */
async function runSkillExitWatchdog(api, recordingId, promptDir, code, signal) {
    const stateDir = api.runtime.state.resolveStateDir();
    const current = await getRecording(stateDir, recordingId);
    // Recording vanished between watchdog scheduling and now (delete RPC).
    // Nothing to patch, nothing to count.
    if (!current)
        return;
    // ──────────────────────────────────────────────────────────────────────
    // code === 0: skill exited cleanly with terminal meta.json
    // ──────────────────────────────────────────────────────────────────────
    if (code === 0) {
        // Skip-of-courtesy: cancel beat us. CAS allowlist ["analyzing"] would
        // also block this, but a pre-check lets us skip the prompt.json read.
        if (current.status === "canceled")
            return;
        // Best-effort cache prompt.json.taskName so subsequent list/status RPCs
        // surface a human-readable title. buildRecordingView lazy-reads
        // prompt.json as fallback, so failure here is harmless.
        let taskName;
        try {
            const promptRaw = await fs.readFile(path.join(promptDir, "prompt.json"), "utf8");
            const promptJson = JSON.parse(promptRaw);
            if (typeof promptJson?.taskName === "string" &&
                promptJson.taskName.trim().length > 0) {
                taskName = promptJson.taskName;
            }
        }
        catch {
            // best-effort
        }
        // endedAt preserve-if-set: parity with derive / zombie / reconcile —
        // stop-path already stamped endedAt and watchdog must not reset it
        // to skill-exit time. Aime reviewer 2026-05-15 P1.
        const patch = { status: "succeeded" };
        if (taskName)
            patch.taskName = taskName;
        if (!current.endedAt)
            patch.endedAt = new Date().toISOString();
        // All terminal side effects below are gated on CAS success. If
        // another path already transitioned this recording to a terminal
        // state, this watchdog must be a pure no-op to avoid duplicate
        // metrics, audit logs, or cleanup of mount mp4.
        let updated;
        try {
            updated = await patchRecordingIfStatus(stateDir, recordingId, ["analyzing"], patch);
        }
        catch (err) {
            api.logger?.error?.(`[video-to-prompt] watchdog failed to patch succeeded ${recordingId}: ${String(err)}`);
            return;
        }
        if (!updated)
            return;
        // CAS won — emit metric + audit + cleanup unconditionally.
        const durationMsSucceeded = current.startedAt
            ? Date.now() - new Date(current.startedAt).getTime()
            : 0;
        incrementCounter("vtp.recording.total", { result: "succeeded" });
        recordHistogram("vtp.recording.duration", Math.max(0, durationMsSucceeded), { result: "succeeded" });
        try {
            vtpLog.info({ rid: recordingId }, {
                event: "state_transition",
                dimension: "recording",
                from: "analyzing",
                to: "succeeded",
                triggerEvent: "system",
            });
        }
        catch {
            /* audit log must never break business flow */
        }
        // 二期 F-A: phase=succeeded 后清挂载点 mp4(仅 keepVideoOnMount=false 时)。
        // 本地 mp4 由 cleanup-scheduler 按 recordingRetentionDays(默认 7 天)兜底
        // 清,这里不动 (spec vtp-video-preview)。best-effort fire-and-forget。
        void cleanupMountMp4OnSucceeded(api, recordingId);
        return;
    }
    // ──────────────────────────────────────────────────────────────────────
    // code !== 0, Path A: skill wrote terminal meta.json before signal.
    // Use the single CAS source of truth (deriveStatusFromMetaTransition).
    // Metric + cleanup are gated on transitioned === true so cancel/zombie
    // racing this watchdog won't cause double-counting.
    // ──────────────────────────────────────────────────────────────────────
    const transition = await deriveStatusFromMetaTransition(stateDir, current);
    if (transition.terminalStatus) {
        if (transition.transitioned) {
            const terminalStatus = transition.terminalStatus;
            const durationMsMeta = current.startedAt
                ? Date.now() - new Date(current.startedAt).getTime()
                : 0;
            incrementCounter("vtp.recording.total", { result: terminalStatus });
            recordHistogram("vtp.recording.duration", Math.max(0, durationMsMeta), {
                result: terminalStatus,
            });
            // #11: skill 写完 succeeded meta.json 后被信号杀(退出码非 0)会走到
            // 此分支,code===0 分支的挂载点 mp4 清理被跳过。补一次清理,与
            // code===0 路径对齐。
            if (terminalStatus === "succeeded") {
                void cleanupMountMp4OnSucceeded(api, recordingId);
            }
        }
        // terminalStatus 存在 (meta.json 已写终态),无论 CAS 是否赢都直接 return —
        // 不进入下方 "force failed" 分支(否则会把 meta.json 终态当成"未写终态")。
        return;
    }
    // ──────────────────────────────────────────────────────────────────────
    // code !== 0, Path B: no terminal meta.json — force failed via CAS.
    // CAS allowlist ["analyzing"] guarantees cancel-then-skill-exit race
    // cannot overwrite canceled → failed.
    // ──────────────────────────────────────────────────────────────────────
    const failPatch = {
        status: "failed",
        error: `skill exited with code ${code}${signal ? ` (signal=${signal})` : ""} before writing terminal meta.json`,
    };
    if (!current.endedAt)
        failPatch.endedAt = new Date().toISOString();
    let forcedFail;
    try {
        forcedFail = await patchRecordingIfStatus(stateDir, recordingId, ["analyzing"], failPatch);
    }
    catch (err) {
        api.logger?.error?.(`[video-to-prompt] watchdog failed to patch ${recordingId}: ${String(err)}`);
        return;
    }
    if (!forcedFail)
        return;
    api.logger?.warn?.(`[video-to-prompt] watchdog patched ${recordingId} → failed (skill exit ${code})`);
    const durationMsFailed = current.startedAt
        ? Date.now() - new Date(current.startedAt).getTime()
        : 0;
    incrementCounter("vtp.recording.total", { result: "failed" });
    recordHistogram("vtp.recording.duration", Math.max(0, durationMsFailed), {
        result: "failed",
    });
}
/**
 * 二期 F-A: analyze phase=succeeded 后清挂载点 mp4(仅 keepVideoOnMount=false
 * 时)。fire-and-forget,不阻塞 watchdog success patch。
 *
 * 关键约束(spec vtp-video-preview "analyze phase=succeeded 后清理挂载点 mp4"):
 *   - 仅删挂载点 mp4 (relay-state.mountAbsolutePath),不动本地 mp4
 *     ($VTP_HOME/runs/<rid>/video.mp4 由 cleanup-scheduler 7 天兜底清)
 *   - keepVideoOnMount=true → 不删 (用户主动选择长期保存)
 *   - 找不到 relay-state.json (老录制) → 不动,降级为 not_enabled 语义
 *   - unlink 失败 → warn log,不抛 (spec "unlink 失败不阻塞 phase")
 */
async function cleanupMountMp4OnSucceeded(api, recordingId) {
    const { resolveVtpHome } = await import("./vtp-paths.js");
    const { readRelayState, safeUnlinkRelayMountVideo } = await import("./mount-relay/relay-state.js");
    try {
        const vtpHome = resolveVtpHome(api);
        const relay = await readRelayState(vtpHome, recordingId);
        if (relay.status !== "completed")
            return; // pending/failed/init: 没挂载点 mp4 可清
        if (relay.keepVideoOnMount)
            return; // 用户选择长期保存
        if (!relay.mountAbsolutePath)
            return; // 异常 state:completed 但无路径
        const unlinkResult = await safeUnlinkRelayMountVideo(recordingId, relay);
        if (unlinkResult.deleted) {
            api.logger?.info?.(`[video-to-prompt] succeededCallback: unlinked mount mp4 ${relay.mountAbsolutePath} (keepVideoOnMount=false)`);
        }
        else if (unlinkResult.unsafe || unlinkResult.error) {
            api.logger?.warn?.(`[video-to-prompt] succeededCallback: unlink mount mp4 failed ${recordingId}: ${unlinkResult.unsafe
                ? "unsafe mount mp4 path in relay-state"
                : unlinkResult.error.message}`);
        }
    }
    catch (err) {
        // readRelayState 解析错误等:fail-open,不阻塞主流程
        api.logger?.warn?.(`[video-to-prompt] succeededCallback: relay-state read failed ${recordingId}: ${err.message}`);
    }
}
// ── plugin config readers ──────────────────────────────────────────────
export function pluginConfig(api) {
    const cfg = api.config?.videoToPrompt ?? {};
    return {
        maxSeconds: typeof cfg.maxRecordingSeconds === "number"
            ? cfg.maxRecordingSeconds
            : DEFAULT_MAX_SECONDS,
        graceSec: typeof cfg.maxRecordingGraceSeconds === "number"
            ? cfg.maxRecordingGraceSeconds
            : DEFAULT_GRACE_SECONDS,
        // R-Round-N H4-a: surface maxSizeMB through the same accessor recording-
        // lifecycle uses for graceSec/maxSeconds, so the stop oversize-check no
        // longer drills into api.config.videoToPrompt directly. ADR-0003 namespace
        // (videoToPrompt.maxRecordingSizeMB).
        maxSizeMB: typeof cfg.maxRecordingSizeMB === "number" && cfg.maxRecordingSizeMB > 0
            ? cfg.maxRecordingSizeMB
            : DEFAULT_MAX_SIZE_MB,
        ffmpegBin: typeof cfg.ffmpegBin === "string" && cfg.ffmpegBin
            ? cfg.ffmpegBin
            : DEFAULT_FFMPEG,
        display: typeof cfg.display === "string" && cfg.display
            ? cfg.display
            : DEFAULT_DISPLAY,
        resolution: typeof cfg.resolution === "string" && cfg.resolution
            ? cfg.resolution
            : DEFAULT_RESOLUTION,
        // M-7 (review 2026-05-25): runtime defense-in-depth。schema 已声明
        // integer [1,60] default 15,但 host 加载校验可能被绕过(programmatic
        // config / 热改);此处兜底拒绝非有限数 / 越界 / 小数。非法值回退默认。
        framerate: Number.isFinite(cfg.framerate) &&
            cfg.framerate >= 1 &&
            cfg.framerate <= 60
            ? Math.floor(cfg.framerate)
            : DEFAULT_FRAMERATE,
        skillScriptPath: typeof cfg.skillScriptPath === "string" && cfg.skillScriptPath
            ? cfg.skillScriptPath
            : null,
    };
}
export function readSkillsConfig(api) {
    const cfg = (api.config?.videoToPrompt ?? {});
    // defaultScope removed — saveAsSkill always writes the vtp-reference
    // layout, so there's nothing for callers to read here.
    const vtpRecordingRoot = typeof cfg.vtpRecordingRoot === "string" && cfg.vtpRecordingRoot
        ? cfg.vtpRecordingRoot
        : "skills/vtp-recording";
    const recordingRetentionDays = typeof cfg.recordingRetentionDays === "number" &&
        cfg.recordingRetentionDays >= 1
        ? cfg.recordingRetentionDays
        : 7;
    const maxReferenceCount = typeof cfg.maxReferenceCount === "number" && cfg.maxReferenceCount >= 1
        ? cfg.maxReferenceCount
        : 100;
    // 二期 F-A saveVideoToMount 超时(秒);default 600s 留 safety margin,
    // 内网 TOS 即使 1-2GB 视频也 10-20s 完成。openclaw.plugin.json
    // configSchema 范围 60-1800,这里同步 clamp。
    const relayTimeoutSeconds = typeof cfg.relayTimeoutSeconds === "number" &&
        cfg.relayTimeoutSeconds >= 60 &&
        cfg.relayTimeoutSeconds <= 1800
        ? cfg.relayTimeoutSeconds
        : 600;
    // 二期 F-B skill-index-scheduler 周期 AUTO-INDEX rebuild 间隔(小时)。
    // 0 = 关周期,只在 startup 跑一次 self-heal;其它 = setInterval(N 小时)。
    const skillIndexRebuildIntervalHours = typeof cfg.skillIndexRebuildIntervalHours === "number" &&
        cfg.skillIndexRebuildIntervalHours >= 0 &&
        cfg.skillIndexRebuildIntervalHours <= 24
        ? cfg.skillIndexRebuildIntervalHours
        : 1;
    // 二期 M2: OTel collector 端点 —— 配置驱动,对齐 CUA 单 `config.otel.endpoint`
    // 风格。单端点同时服务 traces + metrics。configSchema 默认
    // http://localhost:4318;initOtel 内部会写 process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    // spawn 的 runtime SEA 全量继承 env 自动接收(无需逐 caller 注入)。
    const otelEndpoint = typeof cfg.otelEndpoint === "string" && cfg.otelEndpoint
        ? cfg.otelEndpoint
        : undefined;
    return {
        vtpRecordingRoot,
        recordingRetentionDays,
        maxReferenceCount,
        relayTimeoutSeconds,
        skillIndexRebuildIntervalHours,
        otelEndpoint,
    };
}
// ── recording text rendering ──────────────────────────────────────────────
export function renderRecording(r) {
    const lines = [
        `  recordingId: ${r.recordingId}`,
        `  status:      ${r.status}`,
        `  startedAt:   ${r.startedAt}`,
    ];
    if (r.endedAt)
        lines.push(`  endedAt:     ${r.endedAt}`);
    if (typeof r.durationSec === "number")
        lines.push(`  duration:    ${r.durationSec.toFixed(1)}s`);
    if (typeof r.sizeBytes === "number")
        lines.push(`  size:        ${(r.sizeBytes / (1024 * 1024)).toFixed(2)} MB`);
    lines.push(`  videoPath:   ${r.videoPath}`);
    lines.push(`  promptDir:   ${r.promptDir}`);
    if (r.error)
        lines.push(`  error:       ${r.error}`);
    return lines.join("\n");
}
//# sourceMappingURL=helpers.js.map