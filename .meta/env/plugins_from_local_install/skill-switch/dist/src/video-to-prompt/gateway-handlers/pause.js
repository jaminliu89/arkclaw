import { handlePause } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.pause", async (ctx) => {
        await withRpcCommandSpan(ctx, "pause", {}, async (ctx, _span) => {
            try {
                const result = await handlePause(api);
                if (result.type === "error") {
                    respondError(ctx, "RECORDING_PAUSE_FAILED", result.text, {
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
//# sourceMappingURL=pause.js.map