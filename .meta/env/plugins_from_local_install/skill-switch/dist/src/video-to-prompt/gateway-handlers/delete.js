// arkclawVtpRecording.delete RPC handler.
//
// 二期 F-B 方案 B (D-20 双域解耦):
//   - 删整个 runs/<rid>/ 目录 + state.recordings 条目
//   - **不动** reference/<slug>/ (任务模板域,由 deleteSkill 负责)
//   - 已 saveAsSkill 的任务模板继续可调 (invokeSkill / renderInstruction)
//
// 一期实现只删 video.mp4;二期 spec scenario "delete 语义对齐 spec 方案 B"
// 明确要求扩展到整个 run 目录 + 删 state.recordings 条目。
import path from "node:path";
import * as fs from "node:fs/promises";
import { getRecording, isProcessAlive, removeRecording, } from "../recording-state.js";
import { vtpRunsRoot, vtpRunDir, resolveVtpHome } from "../vtp-paths.js";
import { safeRecursiveRm } from "../cleanup-scheduler.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
import { readRelayState, safeUnlinkRelayMountVideo, } from "../mount-relay/relay-state.js";
import { abortRelayForRecording } from "../mount-relay/relay-task.js";
import { stopFfmpegRecording } from "../ffmpeg.js";
import { cancelAutoStop, releaseRecordingDisplayLockBest, } from "../recording-lifecycle.js";
import { pluginConfig } from "../helpers.js";
import { withRecordingLifecycleGate } from "../lifecycle-gate.js";
function isSafeRecordingId(recordingId) {
    return /^[A-Za-z0-9_-]+$/.test(recordingId);
}
async function killSkillProcess(pid) {
    if (!pid || !isProcessAlive(pid))
        return false;
    try {
        process.kill(pid, "SIGTERM");
    }
    catch {
        return false;
    }
    const deadline = Date.now() + 1000;
    while (isProcessAlive(pid) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
    }
    if (isProcessAlive(pid)) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch {
            /* already gone */
        }
    }
    return true;
}
async function deleteRunDir(runDir, runsRoot) {
    const resolvedRunsRoot = path.resolve(runsRoot);
    const resolvedRunDir = path.resolve(runDir);
    const lexicalInsideRunsRoot = resolvedRunDir.startsWith(resolvedRunsRoot + path.sep);
    if (!lexicalInsideRunsRoot) {
        throw new Error(`Refusing to delete runDir outside ${resolvedRunsRoot}: ${resolvedRunDir}`);
    }
    try {
        const realRunsRoot = await fs.realpath(resolvedRunsRoot);
        const st = await fs.lstat(resolvedRunDir);
        if (st.isSymbolicLink()) {
            await fs.unlink(resolvedRunDir).catch(() => { });
            return true;
        }
        const realRunDir = await fs.realpath(resolvedRunDir);
        const physicallyInsideRunsRoot = realRunDir.startsWith(realRunsRoot + path.sep);
        if (!physicallyInsideRunsRoot) {
            throw new Error(`Refusing to delete runDir outside ${realRunsRoot}: ${realRunDir}`);
        }
        if (st.isDirectory()) {
            const rm = await safeRecursiveRm(resolvedRunDir, {
                expectedRoot: { dev: st.dev, ino: st.ino },
            });
            return rm.removed || rm.missing;
        }
        await fs.unlink(resolvedRunDir).catch(() => { });
        return true;
    }
    catch {
        return false;
    }
}
async function forceDeleteRecording(api, recordingId) {
    const stateDir = api.runtime.state.resolveStateDir();
    const cfg = pluginConfig(api);
    const target = await getRecording(stateDir, recordingId);
    const vtpHome = resolveVtpHome(api);
    const relayAbort = await abortRelayForRecording(recordingId);
    const relayState = await readRelayState(vtpHome, recordingId).catch(() => null);
    // I-3 (review 2026-05-25): 保留 safeUnlinkRelayMountVideo 完整 result
    // 用于独立 metric fan-out。响应字段 mountVideoDeleted: boolean 不变
    // (前端契约保持)。metric scope:仅当 relay 已 completed(挂载点真有
    // mp4 可清)时打点 —— 非 completed 状态下 safeUnlinkRelayMountVideo
    // 返回 unsafe sentinel(no work to do),不计入指标,避免 dashboard 噪音。
    const mountUnlink = relayState
        ? await safeUnlinkRelayMountVideo(recordingId, relayState)
        : null;
    const mountVideoDeleted = mountUnlink?.deleted ?? false;
    if (relayState?.status === "completed" && mountUnlink) {
        const mountResult = mountUnlink.deleted
            ? "deleted"
            : mountUnlink.missing
                ? "missing"
                : mountUnlink.unsafe
                    ? "unsafe"
                    : mountUnlink.error
                        ? "error"
                        : "unknown";
        incrementCounter("vtp.recording.delete.mount_video.total", {
            result: mountResult,
            source: "user",
        });
    }
    cancelAutoStop(recordingId);
    let ffmpegKilled = false;
    let skillKilled = false;
    if (target) {
        if (target.ffmpegPid && isProcessAlive(target.ffmpegPid)) {
            const stopped = await stopFfmpegRecording(target.ffmpegPid, {
                graceMs: 1000,
            });
            ffmpegKilled = stopped.sigintSent || stopped.sigkillSent;
        }
        skillKilled = await killSkillProcess(target.skillPid);
    }
    await releaseRecordingDisplayLockBest(stateDir, target?.display ?? cfg.display);
    const runDirDeleted = await deleteRunDir(vtpRunDir(recordingId, api), vtpRunsRoot(api));
    // D.1 (review 2026-05-24, #13): runDir is the recording's primary data
    // domain — when its deletion fails, retain state.recordings entry so the
    // user can retry deletion. Removing state while files linger on disk would
    // hide the recording from the UI but leak storage. mountVideo is an
    // external copy (possibly on an unavailable mount); its deletion failure
    // is surfaced in the response but does NOT block state removal.
    let stateEntryDeleted = false;
    if (!target) {
        // alreadyDeleted — there is no state entry to remove. Leave false.
    }
    else if (runDirDeleted) {
        stateEntryDeleted = await removeRecording(stateDir, recordingId);
    }
    return {
        recordingId,
        alreadyDeleted: !target,
        stateEntryDeleted,
        runDirDeleted,
        mountVideoDeleted,
        ffmpegKilled,
        skillKilled,
        relayAborted: relayAbort.aborted,
        videoDeleted: runDirDeleted,
    };
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.delete", async (ctx) => {
        await withRpcCommandSpan(ctx, "delete", {}, async (ctx, span) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                if (!recordingId) {
                    respondError(ctx, "INVALID_REQUEST", "recordingId is required");
                    return;
                }
                if (!isSafeRecordingId(recordingId)) {
                    respondError(ctx, "INVALID_REQUEST", "invalid recordingId");
                    return;
                }
                span.setAttribute("run_id", recordingId);
                span.setAttribute("vtp.recording_id", recordingId);
                const result = await withRecordingLifecycleGate(() => forceDeleteRecording(api, recordingId));
                // D.1: runDir deletion failed → state preserved → surface as
                // partial failure to the caller so the UI does not show the
                // recording as deleted while the disk still holds artifacts.
                if (!result.alreadyDeleted && !result.runDirDeleted) {
                    incrementCounter("vtp.recording.delete.total", {
                        result: "partial_failure",
                        source: "user",
                    });
                    respondError(ctx, "RECORDING_DELETE_PARTIAL", "Failed to delete recording run directory; state preserved for retry.", { result });
                    return;
                }
                incrementCounter("vtp.recording.delete.total", {
                    result: result.alreadyDeleted ? "not_found" : "deleted",
                    source: "user",
                });
                ctx.respond(true, result);
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=delete.js.map