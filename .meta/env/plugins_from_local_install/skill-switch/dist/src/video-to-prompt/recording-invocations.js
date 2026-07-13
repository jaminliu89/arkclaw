// buildInvocations is a pure renderer kept separate from recording-state.ts
// so the "view rendering" concern is testable without dragging the lock/CRUD
// machinery. recording-state.ts re-exports buildInvocations to preserve the
// import path that test fixtures already rely on.
//
// 注：任务模板「执行次数」(invocations.jsonl / appendInvocation /
// countSuccessfulInvocations) 已整体移除 —— 该功能维度不再需要。本文件现
// 只保留 RecordingView 的「调用方式提示」渲染。
/**
 * Render the invocation hint for a recording row in list/RPC responses.
 *
 * Returns null when status != succeeded (recording not yet executable). The
 * front-end naturally hides the "💬 在聊天里运行" button against null.
 *
 * The single rpcCall string maps to arkclawVtpRecording.renderInstruction —
 * the same RPC the front-end button uses internally. CLI users can `jq -r
 * .data.instruction` on its output to retrieve the natural-language
 * instruction text suitable for pasting into any chat / agent runner.
 */
export function buildInvocations(args) {
    if (args.status !== "succeeded")
        return null;
    // Truthiness — not `!== undefined` — so a defensive empty-string slug
    // (unreachable in practice; slugifySkillName always produces a non-empty
    // slug) falls back to recordingId instead of emitting a guaranteed-broken
    // renderInstruction call (handler rejects empty strings).
    const params = args.slug
        ? { slug: args.slug }
        : { recordingId: args.recordingId };
    const rpcCall = `openclaw gateway call arkclawVtpRecording.renderInstruction --params '${JSON.stringify(params)}'`;
    return { rpcCall };
}
//# sourceMappingURL=recording-invocations.js.map