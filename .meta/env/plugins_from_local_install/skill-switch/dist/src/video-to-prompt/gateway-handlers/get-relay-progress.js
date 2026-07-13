// VTP getRelayProgress RPC handler（二期 —— 视频上传进度专用查询）。
//
// 录制域轻量只读 RPC：专查 saveVideoToMount 的中继上传进度。与 status
// （返回完整 RecordingView）解耦 —— 前端轮询上传进度条只需这一个窄接口，
// 不必拉整个 RecordingView，符合「一个 RPC 一件事」的接口原子性预期。
//
// 数据源 = runs/<rid>/relay-state.json，经 readRelayFieldsForView 派生
// （与 status / result 的 RecordingView 中继字段同一套派生逻辑，保证一致）。
import { getRecording, readRelayFieldsForView } from "../recording-state.js";
import { resolveVtpHome } from "../vtp-paths.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export async function handleGetRelayProgress(api, ctx) {
    const recordingId = typeof ctx.params?.recordingId === "string"
        ? ctx.params.recordingId.trim()
        : "";
    if (!recordingId) {
        return respondError(ctx, "BAD_REQUEST", "recordingId required");
    }
    try {
        const stateDir = api.runtime.state.resolveStateDir();
        const rec = await getRecording(stateDir, recordingId);
        if (!rec) {
            return respondError(ctx, "RECORDING_NOT_FOUND", `recording not found: ${recordingId}`);
        }
        const vtpHome = resolveVtpHome(api);
        const relay = await readRelayFieldsForView(vtpHome, recordingId);
        ctx.respond(true, {
            recordingId,
            videoRelayStatus: relay.videoRelayStatus,
            videoRelayProgress: relay.videoRelayProgress,
            videoRelayError: relay.videoRelayError,
            videoMountFullPath: relay.videoMountFullPath,
            keepVideoOnMount: relay.keepVideoOnMount,
        });
    }
    catch (err) {
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.getRelayProgress", (ctx) => {
        // B-5: 传 run_id 进 span —— 否则 withRpcCommandSpan 的 rpc_call 审计行
        // rid 恒 undefined,按 recordingId 检索 trace 时这条 RPC 断链。
        const recordingId = typeof ctx.params?.recordingId === "string"
            ? ctx.params.recordingId.trim()
            : undefined;
        return withRpcCommandSpan(ctx, "getRelayProgress", recordingId ? { run_id: recordingId } : {}, (c) => handleGetRelayProgress(api, c));
    });
}
//# sourceMappingURL=get-relay-progress.js.map