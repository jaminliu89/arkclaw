// Recording-side RPC handlers — start / stop / pause / resume + the
// auto-stop watchdog. Extracted from commands.ts (R4-D / tsW-size). Public
// surface stable: commands.ts re-exports everything here so gateway.ts and
// tests don't need path changes.
import fs from "node:fs/promises";
import path from "node:path";
import { clearActiveRecording, generateRecordingId, getActiveRecording, getRecording, isProcessAlive, listRecordings, patchRecording, resolveInFlightAfterMeta, upsertRecording, } from "./recording-state.js";
import { pauseFfmpegRecording, resumeFfmpegRecording, spawnFfmpegRecording, stopFfmpegRecording, waitForFinalizedVideo, } from "./ffmpeg.js";
import { invokeVideoToPromptSkill, resolveDefaultSkillScriptPath, } from "./skill-invoker.js";
import { vtpRunsRoot } from "./vtp-paths.js";
import { promptDirForRecording, videoPathForRecording, } from "./result-reader.js";
import { incrementCounter, recordHistogram, } from "./observability/metrics.js";
import { vtpLog } from "./observability/logger.js";
import { withCommandSpan } from "./observability/tracer.js";
import { ACTIVE_STATUSES, makeSkillExitWatchdog, pluginConfig, renderRecording, resolveSkillScriptRoots, validateSkillScriptPath, } from "./helpers.js";
import { withRecordingLifecycleGate } from "./lifecycle-gate.js";
// ── auto-stop watchdog ─────────────────────────────────────────────────────
// recordingId -> setTimeout handle. Used to fire auto-stop at the user-facing
// nominal cap so the server doesn't depend on the frontend to send the stop
// signal. The watchdog is cleared by handleStop / handleCancel.
const watchdogs = new Map();
export function scheduleAutoStop(api, recordingId, delaySec) {
    cancelAutoStop(recordingId);
    const handle = setTimeout(() => {
        watchdogs.delete(recordingId);
        // auto-stop watchdog 是脱离 RPC 的 setTimeout 触发 — 用 withCommandSpan
        // (trigger="system") 织入 command span + command.total/duration metric,
        // 与 cleanup / skill-index scheduler 同机制,否则名义时长自动停录在
        // dashboard 上不可见。
        void withCommandSpan("command.autoStop", "system", { "vtp.recording_id": recordingId }, async () => {
            const stateDir = api.runtime.state.resolveStateDir();
            const current = await getRecording(stateDir, recordingId);
            if (!current || current.status !== "recording") {
                vtpLog.info({ rid: recordingId }, {
                    event: "auto_stop_watchdog",
                    recordingId,
                    outcome: "skipped",
                    reason: current ? `status=${current.status}` : "missing",
                });
                return;
            }
            vtpLog.info({ rid: recordingId }, { event: "auto_stop_watchdog", recordingId, outcome: "firing", delaySec });
            // Auto-stop without triggering analysis — frontend shows the
            // "完成录制 → 生成提示词" panel and the user clicks to analyze.
            await handleStop(api, { mode: "stop", autoTriggered: true });
        }).catch((err) => {
            vtpLog.info({ rid: recordingId }, {
                event: "auto_stop_watchdog",
                recordingId,
                outcome: "error",
                error: String(err),
            });
            api.logger?.error?.(`[video-to-prompt] auto-stop watchdog failed: ${String(err)}`);
        });
    }, delaySec * 1000);
    if (typeof handle.unref === "function") {
        handle.unref();
    }
    watchdogs.set(recordingId, handle);
}
export function cancelAutoStop(recordingId) {
    const h = watchdogs.get(recordingId);
    if (h) {
        clearTimeout(h);
        watchdogs.delete(recordingId);
    }
}
// ── start / stop / pause / resume ──────────────────────────────────────────
// R-Round-N M10: cross-process display lock. wx-open is atomic at the
// kernel level, so concurrent start across host processes can't both win.
// Stale entries (mtime older than DISPLAY_LOCK_STALE_MS) get force-unlinked
// so a crashed host doesn't permanently brick the display; 60s ≫ ffmpeg
// startup time but ≪ a typical recording duration, so a healthy holder
// keeps the lock fresh by way of being the one ffmpeg-spawning process.
const DISPLAY_LOCK_STALE_MS = 60_000;
function displayLockPathFor(stateDir, display) {
    const safe = display.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(stateDir, `.ffmpeg-display-${safe}.lock`);
}
async function acquireDisplayLock(stateDir, display) {
    const lockPath = displayLockPathFor(stateDir, display);
    try {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
    }
    catch {
        // mkdir best-effort — if it fails, the open below will surface the real
        // permission/path error.
    }
    const payload = `pid=${process.pid}\nts=${new Date().toISOString()}\n`;
    try {
        const fh = await fs.open(lockPath, "wx");
        await fh.write(payload);
        await fh.close();
        return { ok: true };
    }
    catch (err) {
        if (err.code !== "EEXIST") {
            return {
                ok: false,
                reason: `display lock acquire failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        // EEXIST — check stale and reclaim if older than threshold.
        try {
            const lst = await fs.lstat(lockPath);
            if (Date.now() - lst.mtimeMs > DISPLAY_LOCK_STALE_MS) {
                await fs.unlink(lockPath).catch(() => { });
                const fh = await fs.open(lockPath, "wx");
                await fh.write(payload);
                await fh.close();
                return { ok: true };
            }
            const ageSec = Math.round((Date.now() - lst.mtimeMs) / 1000);
            return {
                ok: false,
                reason: `display ${display} is locked by another recording (lock age ${ageSec}s; stale threshold ${DISPLAY_LOCK_STALE_MS / 1000}s)`,
            };
        }
        catch {
            return {
                ok: false,
                reason: `display lock stale-check failed for ${display}`,
            };
        }
    }
}
async function releaseDisplayLockBest(stateDir, display) {
    // Best-effort: lock may have been stale-cleaned by another acquirer
    // already, in which case the unlink is a no-op via .catch().
    await fs.unlink(displayLockPathFor(stateDir, display)).catch(() => { });
}
export async function releaseRecordingDisplayLockBest(stateDir, display) {
    await releaseDisplayLockBest(stateDir, display);
}
export async function handleStart(api) {
    return withRecordingLifecycleGate(() => handleStartWithinLifecycleGate(api));
}
export async function handleStartWithinLifecycleGate(api) {
    const stateDir = api.runtime.state.resolveStateDir();
    const cfg = pluginConfig(api);
    const active = await getActiveRecording(stateDir);
    // R10 Critical-①: gate on ACTIVE_STATUSES (recording / paused / analyzing),
    // not just "recording". Slash command path /vtp-recording start hits this
    // function directly (commands.ts handleStart), bypassing gateway.ts's RPC-side
    // ACTIVE_STATUSES guard. Without the broader check, a paused recording
    // (SIGSTOP-frozen but ffmpeg-alive) would let a 2nd ffmpeg spawn against
    // the same display:99 / video.mp4 fd, leaking the original.
    if (active && ACTIVE_STATUSES.has(active.status) && isProcessAlive(active.ffmpegPid)) {
        return {
            text: `A recording is already ${active.status} (${active.recordingId}). Use /vtp-recording stop|cancel to finalize it first.`,
            type: "error",
            recording: active,
        };
    }
    // #11 (review 2026-05-24): start gate uses the single resolveInFlightAfterMeta
    // helper so slash start and RPC start cannot drift on stale-state handling.
    // It picks the in-flight recording, derives terminal status from meta.json
    // via the unified CAS source of truth, and returns null when the in-flight
    // task has already converged (succeeded/failed/canceled).
    const inFlight = await resolveInFlightAfterMeta(stateDir);
    if (inFlight) {
        return {
            text: `A recording task is already ${inFlight.status} (${inFlight.recordingId}). Use /vtp-recording status|result|cancel to finish it first.`,
            type: "error",
            recording: inFlight,
        };
    }
    // R-Round-N M10: cross-process display lock — must run AFTER the
    // ACTIVE_STATUSES guard above (so an active recording's lock isn't
    // mis-classified as stale) but BEFORE generateRecordingId / spawn so the
    // lock is held the moment we own the display.
    const displayLockResult = await acquireDisplayLock(stateDir, cfg.display);
    if (!displayLockResult.ok) {
        return {
            text: displayLockResult.reason,
            type: "error",
        };
    }
    const recordingId = generateRecordingId();
    const videoPath = videoPathForRecording(recordingId, api);
    const promptDir = promptDirForRecording(recordingId, api);
    // ffmpeg hard cap = nominal + grace; the watchdog fires at the nominal value
    // so the user-visible behavior matches "2-minute max" while the server tolerates
    // the round-trip of a frontend stop signal arriving up to `graceSec` late.
    const ffmpegHardCap = cfg.maxSeconds + cfg.graceSec;
    let spawnResult;
    try {
        spawnResult = await spawnFfmpegRecording({
            ffmpegBin: cfg.ffmpegBin,
            display: cfg.display,
            resolution: cfg.resolution,
            framerate: cfg.framerate,
            maxDurationSec: ffmpegHardCap,
            outputPath: videoPath,
            logPath: `${videoPath}.log`,
        });
    }
    catch (err) {
        // R-Round-N M10: spawn failed — release the display lock we acquired
        // above so the next start attempt doesn't have to wait the 60s stale
        // threshold. Best-effort: if release races with stale-clean, no harm done.
        await releaseDisplayLockBest(stateDir, cfg.display);
        throw err;
    }
    const recording = {
        recordingId,
        startedAt: new Date().toISOString(),
        status: "recording",
        videoPath,
        promptDir,
        ffmpegPid: spawnResult.pid,
        resolution: cfg.resolution,
        framerate: cfg.framerate,
        display: cfg.display,
        maxDurationSec: cfg.maxSeconds,
    };
    try {
        await upsertRecording(stateDir, recording, { setActive: true });
        scheduleAutoStop(api, recordingId, cfg.maxSeconds);
    }
    catch (err) {
        await stopFfmpegRecording(spawnResult.pid, { graceMs: 1000 }).catch(() => ({
            stopped: false,
            sigintSent: false,
            sigkillSent: false,
        }));
        await releaseDisplayLockBest(stateDir, cfg.display);
        await fs.rm(path.dirname(videoPath), { recursive: true, force: true }).catch(() => { });
        throw err;
    }
    // Phase 4.2: recording_started audit log
    try {
        vtpLog.info({ rid: recordingId }, {
            event: "recording_started",
            recordingId,
        });
    }
    catch { /* audit log must never break business flow */ }
    return {
        text: [
            `Recording started.`,
            renderRecording(recording),
            "",
            `Max duration: ${cfg.maxSeconds}s (server hard cap ${ffmpegHardCap}s). Use /vtp-recording stop to finalize early; auto-stop fires at ${cfg.maxSeconds}s.`,
        ].join("\n"),
        type: "started",
        recording,
    };
}
export async function handleStop(api, opts) {
    return withRecordingLifecycleGate(() => handleStopInner(api, opts));
}
async function handleStopInner(api, opts) {
    const stateDir = api.runtime.state.resolveStateDir();
    const cfg = pluginConfig(api);
    const active = await getActiveRecording(stateDir);
    if (!active) {
        // Idempotency: the watchdog (or an earlier stop call) may have already
        // cleared the active recording. For stop/cancel, return the most recent
        // recording with noop=true so repeat calls succeed. For analyze, still
        // require an explicit recordingId via arkclawVtpRecording.analyze.
        if (opts.mode === "analyze") {
            return {
                text: "No active recording. Use arkclawVtpRecording.analyze with an explicit recordingId instead.",
                type: "error",
            };
        }
        const all = await listRecordings(stateDir);
        const last = all[0];
        if (!last) {
            return { text: "No active recording.", type: "error" };
        }
        // #10 cancel fallback: if active was already cleared but the most-recent
        // recording is still in a non-terminal state (recording/paused/analyzing),
        // a previous skill / ffmpeg crashed and left it stuck. Force-cancel it
        // (kill any leftover processes + patch status=canceled) so the user can
        // recover without manually editing state.json.
        if (opts.mode === "cancel") {
            const stuck = last.status === "recording" || last.status === "paused" || last.status === "analyzing"
                ? last
                : null;
            if (stuck) {
                if (stuck.ffmpegPid && isProcessAlive(stuck.ffmpegPid)) {
                    await stopFfmpegRecording(stuck.ffmpegPid, { graceMs: 1000 });
                }
                if (stuck.skillPid && isProcessAlive(stuck.skillPid)) {
                    try {
                        process.kill(stuck.skillPid, "SIGTERM");
                    }
                    catch {
                        /* skill may have already exited */
                    }
                    // R6 H3: SIGKILL grace follow-up. Skill may trap SIGTERM and refuse
                    // to exit (or be in uninterruptible sleep). Without escalation we
                    // patch state=canceled but leak the subprocess. setTimeout.unref()
                    // ensures the timer never blocks Node exit.
                    const stuckPid = stuck.skillPid;
                    setTimeout(() => {
                        if (isProcessAlive(stuckPid)) {
                            try {
                                process.kill(stuckPid, "SIGKILL");
                            }
                            catch {
                                /* already gone */
                            }
                        }
                    }, 1000).unref();
                }
                cancelAutoStop(stuck.recordingId);
                const patched = await patchRecording(stateDir, stuck.recordingId, {
                    status: "canceled",
                    endedAt: stuck.endedAt ?? new Date().toISOString(),
                    error: `force-canceled (was stuck in ${stuck.status})`,
                });
                api.logger?.warn?.(`[video-to-prompt] cancel fallback: force-canceled ${stuck.recordingId} (was ${stuck.status})`);
                // Phase 4.1: terminal metric — canceled (force-cancel stuck path).
                const _durationMsForceCanceled = stuck.startedAt
                    ? Date.now() - new Date(stuck.startedAt).getTime()
                    : 0;
                incrementCounter("vtp.recording.total", { result: "canceled" });
                recordHistogram("vtp.recording.duration", Math.max(0, _durationMsForceCanceled), { result: "canceled" });
                return {
                    text: `Force-canceled stuck recording ${stuck.recordingId} (was ${stuck.status}).`,
                    type: "stopped",
                    recording: patched ?? stuck,
                };
            }
            return {
                text: `No active recording. Most recent (${last.recordingId}) already ended as ${last.status}.`,
                type: "stopped",
                recording: last,
                noop: true,
            };
        }
        const text = `No active recording. ${last.recordingId} is already ${last.status} (watchdog or earlier stop).`;
        return { text, type: "stopped", recording: last, noop: true };
    }
    // Cancel pending auto-stop watchdog (no-op if already fired or never set).
    cancelAutoStop(active.recordingId);
    if (active.ffmpegPid && isProcessAlive(active.ffmpegPid)) {
        if (opts.mode !== "cancel" && active.status === "paused") {
            resumeFfmpegRecording(active.ffmpegPid);
        }
        const stopResult = await stopFfmpegRecording(active.ffmpegPid, { graceMs: 5000 });
        if (!stopResult.stopped) {
            const endedAt = new Date().toISOString();
            const patched = await patchRecording(stateDir, active.recordingId, {
                status: "failed",
                endedAt,
                error: "ffmpeg did not exit before stop timeout",
            });
            await clearActiveRecording(stateDir);
            await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
            incrementCounter("vtp.recording.total", { result: "failed" });
            const durationMs = active.startedAt
                ? Date.now() - new Date(active.startedAt).getTime()
                : 0;
            recordHistogram("vtp.recording.duration", Math.max(0, durationMs), { result: "failed" });
            return {
                text: `Recording ${active.recordingId} failed: ffmpeg did not exit before stop timeout.`,
                type: "error",
                recording: patched ?? active,
            };
        }
    }
    if (opts.mode === "cancel") {
        const endedAt = new Date().toISOString();
        const patched = await patchRecording(stateDir, active.recordingId, {
            status: "canceled",
            endedAt,
        });
        await clearActiveRecording(stateDir);
        // R-Round-N M10: release the display lock so the next /vtp-recording
        // start can immediately reuse the display. active.display is the
        // canonical source (set at start time); cfg.display is fallback for the
        // legacy/edge case where state.json predates the display field.
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        // Phase 4.1: terminal metric — canceled (cancel mode).
        const _durationMsCanceled = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        incrementCounter("vtp.recording.total", { result: "canceled" });
        recordHistogram("vtp.recording.duration", Math.max(0, _durationMsCanceled), { result: "canceled" });
        return {
            text: [`Recording canceled.`, renderRecording(patched ?? active)].join("\n"),
            type: "stopped",
            recording: patched ?? active,
        };
    }
    let finalized;
    try {
        finalized = await waitForFinalizedVideo(cfg.ffmpegBin, active.videoPath, {
            timeoutMs: 5000,
            stableIntervalMs: 100,
            minBytes: 1024,
        });
    }
    catch (err) {
        const endedAt = new Date().toISOString();
        const patched = await patchRecording(stateDir, active.recordingId, {
            status: "failed",
            endedAt,
            error: `video finalize failed: ${err.message}`,
        });
        await clearActiveRecording(stateDir);
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        incrementCounter("vtp.recording.total", { result: "failed" });
        const durationMs = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        recordHistogram("vtp.recording.duration", Math.max(0, durationMs), { result: "failed" });
        return {
            text: `Recording ${active.recordingId} failed: video was not finalized.`,
            type: "error",
            recording: patched ?? active,
        };
    }
    const sizeBytes = finalized.sizeBytes;
    const durationSec = finalized.durationSec;
    const endedAt = new Date().toISOString();
    // Hard cap on video file size. ffmpeg -t bounds duration, but extreme
    // framerate / resolution could still produce oversized output. Reject
    // early so downstream analyze/upload won't choke.
    // R-Round-N H4-a: read via pluginConfig (cfg.maxSizeMB) instead of drilling
    // into api.config.videoToPrompt directly, so a future config-shape change
    // only touches helpers.ts pluginConfig().
    const maxSizeMB = cfg.maxSizeMB;
    const maxSizeBytes = maxSizeMB * 1024 * 1024;
    if (typeof sizeBytes === "number" && sizeBytes > maxSizeBytes) {
        const patched = await patchRecording(stateDir, active.recordingId, {
            status: "failed",
            endedAt,
            sizeBytes,
            durationSec,
            error: `oversize: ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB exceeds maxRecordingSizeMB=${maxSizeMB}`,
        });
        await clearActiveRecording(stateDir);
        // 释放 display lock：oversize 与 cancel/stop 一样属于 recording 终结，不释放
        // 会让接下来 60s（DISPLAY_LOCK_STALE_MS）内所有 start 都被拒。active.display
        // 是 canonical 来源；cfg.display 兜底 state.json 缺字段的旧记录。
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        // Phase 4.1: terminal metric — failed (oversize path).
        const _durationMsOversize = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        incrementCounter("vtp.recording.total", { result: "failed" });
        recordHistogram("vtp.recording.duration", Math.max(0, _durationMsOversize), { result: "failed" });
        return {
            text: `Recording ${active.recordingId} rejected: video size ${(sizeBytes / (1024 * 1024)).toFixed(1)}MB > cap ${maxSizeMB}MB.`,
            type: "error",
            recording: patched ?? active,
        };
    }
    if (opts.mode === "stop") {
        const patched = await patchRecording(stateDir, active.recordingId, {
            status: "stopped",
            endedAt,
            sizeBytes,
            durationSec,
        });
        await clearActiveRecording(stateDir);
        // R-Round-N M10: release the display lock — see cancel mode above.
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        // Phase 4.2: audit logs — state_transition + recording_stopped
        const _auditTrigger = opts.autoTriggered ? "system" : "user";
        const _auditDurationMs = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        try {
            vtpLog.info({ rid: active.recordingId }, {
                event: "state_transition",
                dimension: "recording",
                from: active.status,
                to: "stopped",
                triggerEvent: _auditTrigger,
            });
        }
        catch { /* audit log must never break business flow */ }
        try {
            vtpLog.info({ rid: active.recordingId }, {
                event: "recording_stopped",
                recordingId: active.recordingId,
                duration_ms: Math.max(0, _auditDurationMs),
                videoRelayStatus: "not_enabled",
            });
        }
        catch { /* audit log must never break business flow */ }
        return {
            text: [
                `Recording stopped. Use /vtp-recording analyze ${active.recordingId} to trigger prompt generation.`,
                renderRecording(patched ?? active),
            ].join("\n"),
            type: "stopped",
            recording: patched ?? active,
        };
    }
    // mode === "analyze": stop + immediately spawn skill (legacy single-step)
    const skillScriptPath = cfg.skillScriptPath ?? resolveDefaultSkillScriptPath(api);
    // plugin/host 同进程 → 任意 bash spawn = RCE。skillScriptPath 走
    // resolveSkillScriptRoots 白名单（<HOME>/.agents/skills + discovery 发现的 skill 安装根）。
    const stopSkillAllowlist = resolveSkillScriptRoots(api);
    const stopSkillValidation = await validateSkillScriptPath(skillScriptPath, stopSkillAllowlist);
    if (!stopSkillValidation.ok) {
        // R-Coco H3: 与下方 spawn-fail catch 分支同款收尾。原实现仅 return error,
        // 录制会卡在 'recording' 状态、display lock 不释放,前端见「假录制」直到
        // reconcileOnStartup。ffmpeg 已于上方 stopFfmpegRecording 停掉,此处必须补
        // patchRecording(failed) + clearActiveRecording + releaseDisplayLockBest。
        const refusedPatch = await patchRecording(stateDir, active.recordingId, {
            status: "failed",
            endedAt,
            sizeBytes,
            durationSec,
            error: `analyze refused: ${stopSkillValidation.reason}`,
        });
        await clearActiveRecording(stateDir);
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        // Phase 4.1: terminal metric — failed (analyze skill-path validation refused).
        const _durationMsRefused = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        incrementCounter("vtp.recording.total", { result: "failed" });
        recordHistogram("vtp.recording.duration", Math.max(0, _durationMsRefused), { result: "failed" });
        return {
            text: `Refused to spawn skill: ${stopSkillValidation.reason}`,
            type: "error",
            recording: refusedPatch ?? active,
        };
    }
    // R10 W-①: wrap spawn — invokeVideoToPromptSkill throws on assertAbsolute*
    // failure, fs.mkdir failure, or fs.open failure (skill-invoker.ts). Without
    // this catch, an exception here skips both `patchRecording('analyzing')`
    // and clearActiveRecording, leaving the recording stuck in 'recording'
    // status with stale ffmpegPid (already SIGINT'd above) and active pointer
    // intact — frontend sees a phantom `recording` until reconcileOnStartup.
    let invoked;
    try {
        invoked = await invokeVideoToPromptSkill({
            skillScriptPath: stopSkillValidation.resolved,
            videoPath: active.videoPath,
            promptDir: active.promptDir,
            recordingId: active.recordingId,
            allowedVideoRoot: vtpRunsRoot(api),
            onExit: makeSkillExitWatchdog(api, active.recordingId, active.promptDir),
        });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedPatch = await patchRecording(stateDir, active.recordingId, {
            status: "failed",
            endedAt,
            sizeBytes,
            durationSec,
            error: `analyze spawn failed: ${errMsg}`,
        });
        await clearActiveRecording(stateDir);
        await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
        // Phase 4.1: terminal metric — failed (analyze spawn failed).
        const _durationMsSpawnFail = active.startedAt
            ? Date.now() - new Date(active.startedAt).getTime()
            : 0;
        incrementCounter("vtp.recording.total", { result: "failed" });
        recordHistogram("vtp.recording.duration", Math.max(0, _durationMsSpawnFail), { result: "failed" });
        return {
            text: `Recording stopped but analyze failed to spawn: ${errMsg}`,
            type: "error",
            recording: failedPatch ?? active,
        };
    }
    const patched = await patchRecording(stateDir, active.recordingId, {
        status: "analyzing",
        endedAt,
        sizeBytes,
        durationSec,
        skillPid: invoked.pid,
    });
    await clearActiveRecording(stateDir);
    // R-Round-N M10: ffmpeg has been stopped above (line 263 stopFfmpegRecording)
    // — the display is no longer in use even though analyze is still running.
    // Release the lock so a follow-up start can re-acquire it after the
    // single-task gate in start.ts (the in-flight-task selector) clears.
    // NOTE: clearActiveRecording above does NOT mean a new task may start
    // immediately — start RPC scans all recordings for the in-flight-task
    // selector (analyzing included), so the next start blocks until this
    // recording reaches a terminal status (succeeded / failed / canceled).
    await releaseDisplayLockBest(stateDir, active.display ?? cfg.display);
    return {
        text: [
            `Recording stopped. Analysis started.`,
            renderRecording(patched ?? active),
            "",
            `Events log: ${invoked.logPath}`,
            `Poll /vtp-recording result ${active.recordingId} to check progress.`,
        ].join("\n"),
        type: "stopped",
        recording: patched ?? active,
    };
}
export async function handlePause(api) {
    return withRecordingLifecycleGate(() => handlePauseInner(api));
}
async function handlePauseInner(api) {
    const stateDir = api.runtime.state.resolveStateDir();
    const active = await getActiveRecording(stateDir);
    if (!active)
        return { text: "No active recording.", type: "error" };
    if (active.status === "paused") {
        return {
            text: [`Recording already paused.`, renderRecording(active)].join("\n"),
            type: "stopped",
            recording: active,
            noop: true,
        };
    }
    if (active.status !== "recording") {
        return {
            text: `Cannot pause: recording is ${active.status}, not recording.`,
            type: "error",
            recording: active,
        };
    }
    const result = pauseFfmpegRecording(active.ffmpegPid);
    if (!result.paused) {
        return {
            text: `Pause failed: ${result.reason ?? "unknown"}`,
            type: "error",
            recording: active,
        };
    }
    // Cancel the auto-stop watchdog; will be re-armed in handleResume with the
    // remaining recorded-time budget.
    cancelAutoStop(active.recordingId);
    const patched = await patchRecording(stateDir, active.recordingId, {
        status: "paused",
        pausedAt: new Date().toISOString(),
    });
    // Phase 4.2: state_transition audit log
    try {
        vtpLog.info({ rid: active.recordingId }, {
            event: "state_transition",
            dimension: "recording",
            from: active.status,
            to: "paused",
            triggerEvent: "user",
        });
    }
    catch { /* audit log must never break business flow */ }
    return {
        text: [`Recording paused.`, renderRecording(patched ?? active)].join("\n"),
        type: "stopped",
        recording: patched ?? active,
    };
}
export async function handleResume(api) {
    return withRecordingLifecycleGate(() => handleResumeInner(api));
}
async function handleResumeInner(api) {
    const stateDir = api.runtime.state.resolveStateDir();
    const cfg = pluginConfig(api);
    const active = await getActiveRecording(stateDir);
    if (!active)
        return { text: "No active recording.", type: "error" };
    if (active.status === "recording") {
        return {
            text: [`Recording already running.`, renderRecording(active)].join("\n"),
            type: "stopped",
            recording: active,
            noop: true,
        };
    }
    if (active.status !== "paused") {
        return {
            text: `Cannot resume: recording is ${active.status}, not paused.`,
            type: "error",
            recording: active,
        };
    }
    const result = resumeFfmpegRecording(active.ffmpegPid);
    if (!result.resumed) {
        return {
            text: `Resume failed: ${result.reason ?? "unknown"}`,
            type: "error",
            recording: active,
        };
    }
    const now = Date.now();
    const pausedDelta = active.pausedAt ? now - new Date(active.pausedAt).getTime() : 0;
    const cumulativePausedMs = (active.pausedDurationMs ?? 0) + Math.max(0, pausedDelta);
    const startedAtMs = new Date(active.startedAt).getTime();
    // Recorded time = wall-clock-elapsed minus all paused intervals.
    const recordedMs = Math.max(0, now - startedAtMs - cumulativePausedMs);
    const remainingMs = Math.max(1000, cfg.maxSeconds * 1000 - recordedMs);
    const patched = await patchRecording(stateDir, active.recordingId, {
        status: "recording",
        pausedAt: undefined,
        pausedDurationMs: cumulativePausedMs,
    });
    scheduleAutoStop(api, active.recordingId, Math.ceil(remainingMs / 1000));
    return {
        text: [
            `Recording resumed (${Math.round(remainingMs / 1000)}s remaining).`,
            renderRecording(patched ?? active),
        ].join("\n"),
        type: "stopped",
        recording: patched ?? active,
    };
}
//# sourceMappingURL=recording-lifecycle.js.map