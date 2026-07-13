// VTP F-A saveVideoToMount RPC handler (二期新增).
//
// 唯一触发挂载点中继 + 切换「长期保存」标记的入口 (Q24)。覆盖 5 场景:
//   1) stop 后默认预览上传(未中继 → upload + completed 标记)
//   2) 重新上传(stop response 失败后)
//   3) 首次主动转存(未开通网盘 → 后续开通)
//   4) 长期保存(勾选 keepVideoOnMount=true)
//   5) 取消长期保存(keepVideoOnMount=false → 删挂载点 mp4)
//
// 原子 + 幂等 (Q22 + Q25):
//   - relay-state.status="completed" + mp4 存在 → 跳过中继,仅原子更新标记
//   - relay-state.status≠completed → 触发 relayVideoToMount (P-01 inflight)
//   - keepVideoOnMount=undefined → 不动当前标记 (read-then-write 语义)
import { readRelayState, safeUnlinkRelayMountVideo, writeRelayState, } from "../mount-relay/relay-state.js";
import { relayVideoToMount, peekRelayInflight, } from "../mount-relay/relay-task.js";
import { getRecording } from "../recording-state.js";
import { resolveVtpHome, vtpVideoPath } from "../vtp-paths.js";
import { readSkillsConfig } from "../helpers.js";
import * as fs from "node:fs/promises";
import path from "node:path";
import { viewOf, respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
function isString(v) {
    return typeof v === "string";
}
// #7: 同 rid 的 saveVideoToMount 串行化。handler 内 readRelayState → recheck
// → writeRelayState(pending) 这段 read-then-write 非原子;并发同 rid 调用时
// 一个 RPC 的 recheck 与另一个的 writeRelayState 会交错,导致并发 relay 写的
// completed 被覆写回 pending + 启一次冗余 mp4 拷贝。P-01:同 key promise-chain
// 串行,run 在前一个 settle(fulfil/reject 都算)之后才跑;链尾 finally 清 Map。
const _saveSerialize = new Map();
function serializeSaveByRecording(recordingId, run) {
    const prev = _saveSerialize.get(recordingId);
    const next = (prev ? prev.then(run, run) : run()).finally(() => {
        if (_saveSerialize.get(recordingId) === next) {
            _saveSerialize.delete(recordingId);
        }
    });
    _saveSerialize.set(recordingId, next);
    return next;
}
export async function handleSaveVideoToMount(api, ctx) {
    const params = ctx.params;
    const recordingId = isString(params?.recordingId)
        ? params.recordingId.trim()
        : "";
    const mountPathRaw = isString(params?.mountPath) ? params.mountPath : "";
    if (!recordingId) {
        return respondError(ctx, "BAD_REQUEST", "recordingId required");
    }
    if (!mountPathRaw.trim()) {
        return respondError(ctx, "BAD_REQUEST", "mountPath required");
    }
    const mountPath = mountPathRaw.replace(/\/+$/, ""); // trailing slash 容错
    if (!path.isAbsolute(mountPath)) {
        return respondError(ctx, "BAD_REQUEST", "mountPath must be an absolute path");
    }
    const keepIntent = typeof params?.keepVideoOnMount === "boolean"
        ? params.keepVideoOnMount
        : undefined;
    const stateDir = api.runtime.state.resolveStateDir();
    const rec = await getRecording(stateDir, recordingId);
    if (!rec) {
        return respondError(ctx, "RECORDING_NOT_FOUND", `recording not found: ${recordingId}`);
    }
    if (!rec.startedAt) {
        return respondError(ctx, "BAD_REQUEST", "recording has no startedAt — cannot derive TOS path");
    }
    if (rec.status === "recording" || rec.status === "paused") {
        return respondError(ctx, "RECORDING_NOT_READY", `recording ${recordingId} is still ${rec.status}; stop must complete before saving video to mount`);
    }
    if (rec.status === "canceled") {
        return respondError(ctx, "RECORDING_CANCELED", `recording ${recordingId} was canceled; video relay is not available`);
    }
    if (rec.status === "failed" &&
        /video finalize failed|ffmpeg did not exit before stop timeout/i.test(rec.error ?? "")) {
        return respondError(ctx, "VIDEO_NOT_FINALIZED", `recording ${recordingId} video is not finalized; refusing to relay`);
    }
    const vtpHome = resolveVtpHome(api);
    const sourceVideoPath = rec.videoPath ?? vtpVideoPath(recordingId, api);
    try {
        const current = await readRelayState(vtpHome, recordingId);
        // #10: 取消长期保存是不可逆操作 —— evicted 标记后源视频大概率已被
        // cleanup 清理,语义上用户已表达"不要这个视频"。拒绝任何再次
        // saveVideoToMount,避免误以为还能保存(下游 relay 也会因源视频缺失失败)。
        if (current.evicted) {
            return respondError(ctx, "VIDEO_EVICTED", `recording ${recordingId} long-term save was cancelled; it cannot be saved again`);
        }
        const mp4Exists = current.mountAbsolutePath
            ? await fileExists(current.mountAbsolutePath)
            : false;
        const skipRelay = current.status === "completed" && mp4Exists;
        // 场景 5 取消长期保存:status=completed + keepIntent=false +
        // 现 keep=true → 删挂载点 mp4 + 原子写标记(spec scenario "取消长期保存")。
        //
        // 时序契约(I-4 fix):
        //   1) await unlink mp4 — 真删完才进下一步;ENOENT 视为 already-gone OK
        //   2) atomic write evicted=true — 不可逆,后续 save 一律拒绝 VIDEO_EVICTED
        // 旧版有两次 write + fire-and-forget unlink,中间窗口前端可能读到
        // "completed + keep=false + mountAbsolutePath 仍指向已不存在文件",
        // 导致 UI 显示"可回放"但点开 404。本次合并为单次 write + 同步 unlink
        // 消除该 race。
        if (skipRelay &&
            keepIntent === false &&
            current.keepVideoOnMount === true &&
            current.mountAbsolutePath) {
            const unlinkResult = await safeUnlinkRelayMountVideo(recordingId, current, mountPath);
            if (unlinkResult.unsafe || unlinkResult.error) {
                const message = unlinkResult.unsafe
                    ? "unsafe mount mp4 path in relay-state"
                    : unlinkResult.error.message;
                api.logger?.warn?.(`saveVideoToMount: unlink mount mp4 failed (best-effort): ${message}`);
                return respondError(ctx, "MOUNT_VIDEO_DELETE_FAILED", `failed to delete mount mp4 for recording ${recordingId}: ${message}`);
            }
            // missing = 文件本来就不在,符合"取消保存后挂载点无 mp4"语义,继续
            await writeRelayState(vtpHome, recordingId, {
                status: "completed",
                keepVideoOnMount: false,
                evicted: true,
                startedAt: current.startedAt,
            });
            ctx.respond(true, {
                recording: await viewOf(api, recordingId, vtpHome),
                message: "long-term save cancelled; mount mp4 removed",
            });
            return;
        }
        // 场景 2: 视频已中继 → 仅原子更新标记(若 keepIntent 提供)。
        if (skipRelay) {
            if (keepIntent === undefined) {
                ctx.respond(true, {
                    recording: await viewOf(api, recordingId, vtpHome),
                    message: "already completed; no flag change",
                });
                return;
            }
            await writeRelayState(vtpHome, recordingId, {
                ...current,
                keepVideoOnMount: keepIntent,
            });
            ctx.respond(true, {
                recording: await viewOf(api, recordingId, vtpHome),
                message: keepIntent === true
                    ? "already completed; flag updated to keep"
                    : "already completed; flag updated to not keep",
            });
            return;
        }
        // 场景 1/3/4: 未中继或失败 → 触发 relay-task(P-01 dedupe)。
        // keepIntent=undefined 时用当前 relay-state 的 keepVideoOnMount 兜底,
        // 保留 "不传不动标记" 语义。
        //
        // 评审修正 — saveVideoToMount 真异步: relay copy 是后台任务,**不 await**。
        // RPC 立即返回 (videoRelayStatus=pending),前端轮询 status RPC 读
        // recording.videoRelayProgress 拿上传进度;relay 成功/失败都由 relayInner
        // 写进 relay-state.json,前端通过 status 的 videoRelayStatus +
        // relayErrorCode 感知终态。timeoutMs(configSchema.relayTimeoutSeconds,
        // default 600s)是后台拷贝的超时上限,不再阻塞本 RPC。
        const effectiveKeep = keepIntent !== undefined ? keepIntent : current.keepVideoOnMount;
        const cfg = readSkillsConfig(api);
        // B-1: 关闭上面 readRelayState 与下面 writeRelayState(pending) 之间的
        // TOCTOU —— 并发同 rid 时另一个 RPC 的 detached relay 可能已 completed;
        // 不重读会把 completed 覆写回 pending(前端 videoRelayStatus 闪回
        // "上传中")+ 启一次冗余 mp4 拷贝(P-01 inflight 已清、无法去重)。
        const recheck = await readRelayState(vtpHome, recordingId);
        if (recheck.status === "completed") {
            ctx.respond(true, {
                recording: await viewOf(api, recordingId, vtpHome),
                message: "already completed by a concurrent saveVideoToMount",
            });
            return;
        }
        // H2: 在途 relay 指向别的挂载点 → 拒绝。relay-state.json 单 recording
        // 单文件,无法表达一个 rid 并发中继到多挂载点;放行会让两个 relay 并发
        // 写同一文件互相覆盖 status/progress。同挂载点的在途 relay 不拦 ——
        // 下面 relayVideoToMount 的 inflight gate 会去重(幂等重试安全)。
        const inflight = peekRelayInflight(recordingId);
        if (inflight && inflight.mountPath !== mountPath) {
            return respondError(ctx, "RELAY_BUSY", `recording ${recordingId} is already being relayed to a different mount (${inflight.mountPath}); retry after it finishes`);
        }
        // M1: 先同步落 status=pending 再 detach 后台 relay。否则下面的 viewOf
        // 早于后台 relayVideoToMount 写 pending,首个 RPC 响应里的
        // recording.videoRelayStatus 仍是旧值(init / 上次终态),与
        // message "relay started" 自相矛盾,前端首帧拿到错的中继状态。
        await writeRelayState(vtpHome, recordingId, {
            status: "pending",
            keepVideoOnMount: effectiveKeep,
            startedAt: new Date().toISOString(),
        });
        void relayVideoToMount({
            vtpHome,
            recordingId,
            sourceVideoPath,
            mountPath,
            startedAtIso: rec.startedAt,
            keepVideoOnMount: effectiveKeep,
            timeoutMs: cfg.relayTimeoutSeconds * 1000,
        })
            .then((result) => {
            // A-3: relayInner 失败路径 writeFailedState 后 resolve {ok:false}
            // (不 reject),仅 relay-state.json 留痕。生产排查 (vtp.log) 需
            // 这条 warn 才能定位 SYMLINK_REJECTED / DISK_FULL / RELAY_TIMEOUT。
            if (!result.ok) {
                api.logger?.warn?.(`[vtp] saveVideoToMount: detached relay failed rid=${recordingId} ` +
                    `code=${result.errorCode} msg=${result.errorMessage}`);
            }
        })
            .catch((err) => {
            // 兜底防 detached promise 的 unhandled rejection。
            api.logger?.warn?.(`[vtp] saveVideoToMount: detached relay rejected rid=${recordingId}: ${err instanceof Error ? err.message : String(err)}`);
        });
        ctx.respond(true, {
            recording: await viewOf(api, recordingId, vtpHome),
            message: "relay started; poll status for videoRelayProgress",
        });
    }
    catch (err) {
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
async function fileExists(p) {
    try {
        await fs.stat(p);
        return true;
    }
    catch {
        return false;
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.saveVideoToMount", async (ctx) => {
        const recordingId = typeof ctx.params?.recordingId === "string"
            ? ctx.params.recordingId.trim()
            : undefined;
        await withRpcCommandSpan(ctx, "saveVideoToMount", recordingId ? { run_id: recordingId } : {}, async (ctx, span) => {
            if (recordingId) {
                span.setAttribute("vtp.recording_id", recordingId);
                // #7: 有 recordingId 才能串行化;无则 handler 自报 BAD_REQUEST。
                await serializeSaveByRecording(recordingId, () => handleSaveVideoToMount(api, ctx));
            }
            else {
                await handleSaveVideoToMount(api, ctx);
            }
        });
    });
}
//# sourceMappingURL=save-video-to-mount.js.map