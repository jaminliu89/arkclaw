// Shared helpers + types for gateway-handlers/*.
//
// Extracted from gateway.ts to keep that file under the CLAUDE.md 800-line cap
// (was 902 LOC). Each handler under gateway-handlers/ exports `register(api)`
// and uses these helpers; gateway.ts now only chains those registers.
//
// Mechanical extraction — no behavior change. ADR-0005 minimum-change rule.
import { buildRecordingView } from "../recording-state.js";
import { resolveVtpHome } from "../vtp-paths.js";
// CLI 端 ajv 用 ErrorShapeSchema 校验 (additionalProperties:false)，只允许
// {code, message, details?, retryable?, retryAfterMs?}。把 plugin 的扩展字段
// (recording / errors / availableSkills 等) 平铺进顶层会被 silently rejected
// → CLI pending 永不 resolve → 10s timeout（host log 仍会打 ⇄ res ✗，因为
// host 不做校验，是 CLI 的 client.ts:781 validateResponseFrame 拒了）。
// 把 extra 整体塞进 details 字段（schema 是 Type.Unknown()，接受任意 JSON）。
export function respondError(ctx, code, message, extra) {
    const error = {
        code,
        message,
    };
    if (extra && Object.keys(extra).length > 0) {
        error.details = extra;
    }
    ctx.respond(false, undefined, error);
}
// R-Round-N H9: redact unknown errors before sending to the frontend.
// String(err) on a Node Error returns "Error: <message>" — the message can
// contain absolute file paths (ENOENT errors include `path` in the message
// since Node 14) that disclose deployment layout. Convert to a clean
// human-readable string here; the full err object (including stack) is
// preserved at the call site through api.logger.warn so root-cause analysis
// stays possible without crossing the gateway boundary.
export function redactError(_err) {
    return "internal error";
}
// Async wrapper: every RPC needs the unified RecordingView shape. Returns
// null only when the recording was deleted between state read and view
// build; callers should treat that as "not found".
//
// 二期 F-A: 调用方可传 vtpHome 让 buildRecordingView 读 relay-state.json 填
// 视频中继字段(videoRelayStatus / videoMountFullPath 等)。不传则字段降级为
// not_enabled(spec "老录制无 relay-state.json")。
export async function viewOf(api, recordingId, vtpHome) {
    const stateDir = api.runtime.state.resolveStateDir();
    return buildRecordingView(stateDir, recordingId, vtpHome);
}
// Convenience: caller already has the RecordingMetadata in hand; resolve view
// by its recordingId. Falls back to null (race with delete) so callers can
// pass through to the response shape.
//
// 二期 F-A: 必须转发 vtpHome,否则 buildRecordingView 收到 undefined →
// readRelayFieldsForView 短路返回 not_enabled 兜底,所有经此 helper 的 RPC
// (status / result / start / analyze / cancel / pause / resume / stop /
// update-prompt …) 的 RecordingView 视频中继字段全部失效。resolveVtpHome
// 是同步纯函数,无副作用,无条件 resolve 安全(老录制无 relay-state.json 时
// buildRecordingView 仍降级 not_enabled)。
export async function viewOfRecording(api, rec) {
    if (!rec)
        return null;
    return viewOf(api, rec.recordingId, resolveVtpHome(api));
}
// R6 Critical-2: per-call cap for events RPC log read. A runaway / malicious
// skill writing a multi-GB events.jsonl would otherwise let one events RPC alloc
// `len = stat.size - since` bytes of Buffer and OOM-kill the plugin host.
// 10MB ≈ 30k typical event lines, comfortably above any single-poll volume;
// when exceeded, response carries `truncated: true` + nextCursor advanced
// past the read window so front-end resumes paginating.
export const MAX_LOG_TAIL_BYTES = 10 * 1024 * 1024;
//# sourceMappingURL=shared.js.map