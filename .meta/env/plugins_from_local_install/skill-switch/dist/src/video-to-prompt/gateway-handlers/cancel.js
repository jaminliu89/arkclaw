import { handleCancelAnalysis } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.cancel", async (ctx) => {
        await withRpcCommandSpan(ctx, "cancel", {}, async (ctx, span) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                if (!recordingId) {
                    respondError(ctx, "INVALID_REQUEST", "recordingId is required");
                    return;
                }
                span.setAttribute("run_id", recordingId);
                span.setAttribute("vtp.recording_id", recordingId);
                const result = await handleCancelAnalysis(api, recordingId);
                if (result.type === "error") {
                    const code = result.errorCode ?? "RECORDING_CANCEL_FAILED";
                    respondError(ctx, code, result.text, {
                        recording: await viewOfRecording(api, result.recording),
                    });
                    return;
                }
                ctx.respond(true, {
                    recording: await viewOfRecording(api, result.recording),
                    message: result.text,
                });
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=cancel.js.map