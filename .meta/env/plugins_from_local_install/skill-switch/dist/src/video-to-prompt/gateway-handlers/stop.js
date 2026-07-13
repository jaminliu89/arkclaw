import { handleStop } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.stop", async (ctx) => {
        await withRpcCommandSpan(ctx, "stop", {}, async (ctx, _span) => {
            try {
                // Default = "stop" (just halt ffmpeg, keep video, don't analyze).
                // Frontend prototype: user clicks ⬛ then sees "完成录制" panel and
                // explicitly clicks "生成提示词" to trigger arkclawVtpRecording.analyze.
                // Back-compat: { triggerAnalysis: true } → { mode: "analyze" }.
                let mode = "stop";
                const explicitMode = ctx.params?.mode;
                if (explicitMode === "stop" ||
                    explicitMode === "cancel" ||
                    explicitMode === "analyze") {
                    mode = explicitMode;
                }
                else if (ctx.params?.triggerAnalysis === true) {
                    mode = "analyze";
                }
                const result = await handleStop(api, { mode });
                if (result.type === "error") {
                    respondError(ctx, "RECORDING_STOP_FAILED", result.text);
                    return;
                }
                ctx.respond(true, {
                    recording: await viewOfRecording(api, result.recording),
                    message: result.text,
                    noop: result.noop ?? false,
                });
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=stop.js.map