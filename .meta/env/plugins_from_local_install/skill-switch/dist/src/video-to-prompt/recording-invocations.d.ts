import type { RecordingInvocations, RecordingStatus } from "./types.js";
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
export declare function buildInvocations(args: {
    recordingId: string;
    slug?: string;
    status: RecordingStatus;
}): RecordingInvocations | null;
//# sourceMappingURL=recording-invocations.d.ts.map