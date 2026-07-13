import { handleStartWithinLifecycleGate } from "../recording-lifecycle.js";
import { resolveInFlightAfterMeta } from "../recording-state.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
import { withRecordingLifecycleGate } from "../lifecycle-gate.js";
// Single-task-at-a-time gate. Task boundary: start ⇒ terminal ∈
// {succeeded, failed, canceled}. A new start is idempotent (returns the
// in-flight recording with resumedFromExisting=true) whenever a prior task
// is still in {recording, paused, analyzing, stopped+video}.
//
// Implementation: `resolveInFlightAfterMeta` (recording-state.ts) is the
// single helper for "is there a task blocking start?". It internally combines
// pickDefaultRecording("in-flight-task") with deriveStatusFromMeta so stale
// `analyzing` records whose runtime already wrote terminal meta.json don't
// permanently block fresh starts. Shared with recording-lifecycle.ts slash
// path so slash + RPC entries cannot drift on stale-state handling.
//
// History: the gate originally lived inline here as two separate branches
// (getActiveRecording + pickDefaultRecording("resumable-stopped")). An
// analyzing recording slipped through both because lifecycle clears
// activeRecordingId on stop→analyzing. Collapsed into one in-flight-task
// selector so all four non-terminal states share the gate.
function describeBlockedTask(status) {
    switch (status) {
        case "recording":
            return "is still recording; stop or cancel it before starting a new task.";
        case "paused":
            return "is paused; resume + stop, or cancel it, before starting a new task.";
        case "analyzing":
            return "is still analyzing; wait for completion or cancel it before starting a new task.";
        case "stopped":
            return "is stopped but not yet analyzed; analyze / saveAsSkill / delete it before starting a new task.";
        case "succeeded":
        case "failed":
        case "canceled":
            // Selector "in-flight-task" never returns terminal statuses; this arm
            // exists so adding a new RecordingMetadata.status fails to compile
            // until describeBlockedTask is extended.
            throw new Error(`unreachable: in-flight-task selector returned terminal status ${status}`);
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.start", async (ctx) => {
        await withRpcCommandSpan(ctx, "start", {}, async (ctx, span) => {
            try {
                await withRecordingLifecycleGate(async () => {
                    const stateDir = api.runtime.state.resolveStateDir();
                    // resolveInFlightAfterMeta returns null when:
                    //   - no in-flight recording, or
                    //   - in-flight recording was reconciled to terminal
                    //     (succeeded/failed/canceled) via the unified CAS source
                    //     of truth — fresh start can proceed in that case.
                    // Returns the (possibly reconciled) recording when it remains
                    // active — we surface it as resumedFromExisting.
                    const inFlight = await resolveInFlightAfterMeta(stateDir);
                    if (inFlight) {
                        // I-1: 经 viewOfRecording(内部 resolveVtpHome)而非裸 viewOf,
                        // 否则 resumed_existing 路径的 RecordingView relay 字段恒
                        // not_enabled —— 前端"恢复已有录制"看不到视频中继状态。
                        const view = await viewOfRecording(api, inFlight);
                        // Phase 4.1: start metric — resumed_existing (in-flight task gate).
                        incrementCounter("vtp.recording.start.total", {
                            result: "resumed_existing",
                        });
                        ctx.respond(true, {
                            recording: view ? { ...view, resumedFromExisting: true } : null,
                            message: `Existing recording ${inFlight.recordingId} ${describeBlockedTask(inFlight.status)}`,
                            resumedFromExisting: true,
                        });
                        return;
                    }
                    const result = await handleStartWithinLifecycleGate(api);
                    if (result.type === "error") {
                        // Phase 4.1: start metric — rejected.
                        incrementCounter("vtp.recording.start.total", {
                            result: "rejected",
                        });
                        respondError(ctx, "RECORDING_START_FAILED", result.text, {
                            recording: await viewOfRecording(api, result.recording),
                        });
                        return;
                    }
                    // Phase 4.1: start metric — accepted (fresh recording spawned).
                    incrementCounter("vtp.recording.start.total", { result: "accepted" });
                    // Tag span with the newly created recording id
                    const recording = await viewOfRecording(api, result.recording);
                    if (recording?.recordingId) {
                        span.setAttribute("run_id", recording.recordingId);
                        span.setAttribute("vtp.recording_id", recording.recordingId);
                    }
                    ctx.respond(true, {
                        recording,
                        message: result.text,
                    });
                });
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=start.js.map