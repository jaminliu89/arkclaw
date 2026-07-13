import { handleSaveAsSkill } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.saveAsSkill", async (ctx) => {
        await withRpcCommandSpan(ctx, "saveAsSkill", {}, async (ctx, span) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                if (recordingId) {
                    span.setAttribute("run_id", recordingId);
                    span.setAttribute("vtp.recording_id", recordingId);
                }
                const name = typeof ctx.params?.name === "string" && ctx.params.name
                    ? ctx.params.name
                    : undefined;
                const description = typeof ctx.params?.description === "string" && ctx.params.description
                    ? ctx.params.description
                    : undefined;
                // scope param removed from RPC surface — handler always writes to the
                // vtp-reference directory. The response message intentionally does not
                // hint at any alternative scope.
                const overwrite = ctx.params?.overwrite === true;
                const prompt = ctx.params?.prompt && typeof ctx.params.prompt === "object"
                    ? ctx.params.prompt
                    : undefined;
                const result = await handleSaveAsSkill(api, recordingId, {
                    prompt,
                    name,
                    description,
                    overwrite,
                });
                if (result.type === "error") {
                    respondError(ctx, "RECORDING_SAVE_SKILL_FAILED", result.text, {
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
//# sourceMappingURL=save-as-skill.js.map