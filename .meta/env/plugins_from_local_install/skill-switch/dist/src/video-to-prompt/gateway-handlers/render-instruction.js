// arkclawVtpRecording.renderInstruction — returns the prompt-rendered
// instruction text + metadata (recordingId, taskName, stepCount).
//
// Used by the frontend "💬 在聊天里运行" button: the UI pastes the returned
// instruction into the chat input; the host model then drives execution via
// natural channel-block streaming.
//
// Namespace: arkclawVtpRecording.* (new; Task 7 renames arkclawVtpRecording.*).
// Error envelope: ADR-0008 strict {code, message, details?}.
import { resolveAndPreparePrompt } from "../prompt-rendering.js";
import { respondError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
// Guard: return a non-empty string or null.
function readString(v) {
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
export async function handleRenderInstruction(api, ctx) {
    const recordingId = readString(ctx.params?.recordingId);
    const slug = readString(ctx.params?.slug);
    // Require at least one identifier.
    if (!recordingId && !slug) {
        respondError(ctx, "BAD_REQUEST", "recordingId or slug is required", {
            hint: "Pass { recordingId } for a live recording or { slug } for a saved skill.",
        });
        return;
    }
    // Use recordingId if present, otherwise slug as the lookup key.
    const lookupKey = recordingId ?? slug ?? null;
    const prep = await resolveAndPreparePrompt(api, lookupKey, {});
    if (prep.errorCode) {
        respondError(ctx, prep.errorCode, prep.errorText ?? "Failed to prepare prompt.", prep.errorDetails);
        return;
    }
    // V6.4 post-review fix-L+H: 复用 resolveAndPreparePrompt 已渲染的 promptText
    // (renderUserFacingPrompt 内部已 NUL-strip),消除双重渲染 + 删 dead fallback
    // (resolver 保证 success/PROMPT_EMPTY 路径同时填 promptText + prompt)。
    const instruction = prep.promptText ?? "";
    const stepCount = prep.prompt?.steps?.length ?? 0;
    const rec = prep.recording;
    ctx.respond(true, {
        instruction,
        recordingId: rec?.recordingId ?? lookupKey ?? "",
        taskName: rec?.taskName ?? null,
        stepCount,
    });
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.renderInstruction", async (ctx) => {
        const recordingId = readString(ctx.params?.recordingId);
        const slug = readString(ctx.params?.slug);
        await withRpcCommandSpan(ctx, "renderInstruction", {}, async (ctx, span) => {
            if (recordingId) {
                span.setAttribute("run_id", recordingId);
                span.setAttribute("vtp.recording_id", recordingId);
            }
            if (slug) {
                span.setAttribute("vtp.template_slug", slug);
            }
            await handleRenderInstruction(api, ctx);
        });
    });
}
//# sourceMappingURL=render-instruction.js.map