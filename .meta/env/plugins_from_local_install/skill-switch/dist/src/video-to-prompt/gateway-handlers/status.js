import { handleStatus } from "../commands.js";
import { deriveStatusFromMeta } from "../recording-state.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
// L-18: the "no recordingId → fall back to a stopped-with-video recording"
// branch lives inside `handleStatus` (analysis-lifecycle.ts) so the CLI
// `/vtp-recording status` path and the gateway RPC return the same view.
// Without that, status disagreed with start branch B and the front end saw
// `recording: null` while start refused to spawn. This handler stays a thin
// view-shaping wrapper: handleStatus picks the metadata, deriveStatusFromMeta
// reconciles meta.json drift, viewOfRecording converts to RecordingView.
//
// The view is annotated with `resumedFromExisting: true` when the underlying
// recording is in the resumable-stopped fallback bucket — this mirrors start
// branch B's marker so the front end can render the resume card without
// having to special-case which RPC delivered the view.
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.status", async (ctx) => {
        await withRpcCommandSpan(ctx, "status", {}, async (ctx) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string" ? ctx.params.recordingId : null;
                const result = await handleStatus(api, recordingId);
                let recording = result.recording ?? null;
                if (!recording) {
                    ctx.respond(true, { recording: null });
                    return;
                }
                const stateDir = api.runtime.state.resolveStateDir();
                recording = await deriveStatusFromMeta(stateDir, recording);
                const view = await viewOfRecording(api, recording);
                // A resumable-stopped fallback hit means the caller didn't ask for a
                // specific id and there was no active recording — surface it as the
                // resume-card view (start branch B parity).
                const isFallback = !recordingId && view !== null && recording.status === "stopped";
                ctx.respond(true, {
                    recording: isFallback ? { ...view, resumedFromExisting: true } : view,
                });
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=status.js.map