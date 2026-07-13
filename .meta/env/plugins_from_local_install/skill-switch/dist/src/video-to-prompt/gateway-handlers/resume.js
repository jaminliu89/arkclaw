import { handleResume } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.resume", async (ctx) => {
        await withRpcCommandSpan(ctx, "resume", {}, async (ctx, _span) => {
            try {
                const result = await handleResume(api);
                if (result.type === "error") {
                    respondError(ctx, "RECORDING_RESUME_FAILED", result.text, {
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
//# sourceMappingURL=resume.js.map