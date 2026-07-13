import { handleUpdatePrompt } from "../commands.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.updatePrompt", async (ctx) => {
        await withRpcCommandSpan(ctx, "updatePrompt", {}, async (ctx, span) => {
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
                const prompt = ctx.params?.prompt &&
                    typeof ctx.params.prompt === "object" &&
                    !Array.isArray(ctx.params.prompt)
                    ? ctx.params.prompt
                    : null;
                if (!prompt) {
                    respondError(ctx, "INVALID_REQUEST", "prompt must be an object");
                    return;
                }
                // R6 N12: forward as-is (undefined / true / false). Handler owns the
                // default (`opts.reindexSteps !== false` → defaults true) so the rule
                // lives in exactly one place.
                const reindexSteps = ctx.params?.reindexSteps;
                const result = await handleUpdatePrompt(api, recordingId, {
                    prompt,
                    reindexSteps,
                });
                if (result.type === "error") {
                    try {
                        incrementCounter("vtp.template.update.total", {
                            kind: "prompt",
                            result: "error",
                            error_code: result.errorCode ?? "PROMPT_UPDATE_FAILED",
                        });
                    }
                    catch {
                        // silent
                    }
                    respondError(ctx, result.errorCode ?? "PROMPT_UPDATE_FAILED", result.text, {
                        recording: await viewOfRecording(api, result.recording),
                        ...(result.errors ? { errors: result.errors } : {}),
                    });
                    return;
                }
                try {
                    incrementCounter("vtp.template.update.total", {
                        kind: "prompt",
                        result: "success",
                    });
                }
                catch {
                    // silent
                }
                ctx.respond(true, {
                    recording: await viewOfRecording(api, result.recording),
                    prompt: result.prompt,
                    meta: result.meta,
                    revision: result.revision,
                    bakCreated: result.bakCreated,
                });
            }
            catch (err) {
                try {
                    incrementCounter("vtp.template.update.total", {
                        kind: "prompt",
                        result: "error",
                        error_code: "INTERNAL_ERROR",
                    });
                }
                catch {
                    // silent
                }
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=update-prompt.js.map