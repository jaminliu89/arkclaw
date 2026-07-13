import { handleAnalyze } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.analyze", async (ctx) => {
        await withRpcCommandSpan(ctx, "analyze", {}, async (ctx, span) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                if (recordingId) {
                    span.setAttribute("run_id", recordingId);
                    span.setAttribute("vtp.recording_id", recordingId);
                }
                const result = await handleAnalyze(api, recordingId);
                if (result.type === "error") {
                    respondError(ctx, "RECORDING_ANALYZE_FAILED", result.text, {
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
//# sourceMappingURL=analyze.js.map