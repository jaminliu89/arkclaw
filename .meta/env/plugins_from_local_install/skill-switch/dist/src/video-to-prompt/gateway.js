// Gateway register dispatcher for vtp-recording RPCs.
//
// Each RPC handler lives in ./gateway-handlers/<name>.ts as `register(api)`.
// This file chains all of them so plugin/index.ts only needs a single import.
//
// Refactor history: this file was 902 LOC with 15 RPC handlers inline; the
// CLAUDE.md 800-line cap was violated and reviewer ergonomics were poor (no
// jump-to-symbol per RPC). Mechanical extraction per ADR-0005 minimum-change
// rule moved each handler to ./gateway-handlers/, leaving this file as a
// register chain. Zero behavior change — same RPC names, same payloads, same
// error envelopes (ADR-0008), same in-flight gates (events.ts owns its own
// module-level Map).
import { initOtel } from "./observability/otel.js";
import { readSkillsConfig } from "./helpers.js";
import { register as registerStart } from "./gateway-handlers/start.js";
import { register as registerStop } from "./gateway-handlers/stop.js";
import { register as registerPause } from "./gateway-handlers/pause.js";
import { register as registerResume } from "./gateway-handlers/resume.js";
import { register as registerSaveAsSkill } from "./gateway-handlers/save-as-skill.js";
import { register as registerAnalyze } from "./gateway-handlers/analyze.js";
import { register as registerCancel } from "./gateway-handlers/cancel.js";
import { register as registerEvents } from "./gateway-handlers/events.js";
import { register as registerStatus } from "./gateway-handlers/status.js";
// 二期 F-B: 任务模板域 5 新 RPC (D-20 双域解耦)
import { register as registerListSkill } from "./gateway-handlers/list-skill.js";
import { register as registerGetSkill } from "./gateway-handlers/get-skill.js";
import { register as registerInvokeSkill } from "./gateway-handlers/invoke-skill.js";
import { register as registerDeleteSkill } from "./gateway-handlers/delete-skill.js";
import { register as registerUpdateSkill } from "./gateway-handlers/update-skill.js";
import { register as registerResult } from "./gateway-handlers/result.js";
import { register as registerUpdatePrompt } from "./gateway-handlers/update-prompt.js";
import { register as registerDelete } from "./gateway-handlers/delete.js";
// 二期: arkclawVtpRecording.exportTrace 已删除 (spec §4.7 20 RPC 不含此项,
// trace 走 OTel collector dashboard 按 runId/traceId 查;handler 文件已 rm)
import { register as registerRenderInstruction } from "./gateway-handlers/render-instruction.js";
import { register as registerSaveVideoToMount } from "./gateway-handlers/save-video-to-mount.js";
import { register as registerGetRelayProgress } from "./gateway-handlers/get-relay-progress.js";
// arkclawVtpRecording.getVideoFile 已废弃：plugin RPC 不传视频字节（避免节流），
// 所有视频详情字段（videoPath / videoExists / sizeBytes / format / durationSec /
// resolution）都在统一 RecordingView 里。前端改调 arkclawVtpRecording.status 拿
// 同等元数据，然后走宿主下载通道基于 videoPath 获取视频内容。
export function registerCuaRecordingGateway(api) {
    // 初始化 OTel SDK — 幂等，失败 silent（initOtel 内部 try/catch 返回 null）。
    // 传 "plugin" 作为 serviceInstanceId：plugin 进程生命周期内无单一 runId。
    // M2: endpoint 从 configSchema 读（配置驱动，对齐 CUA config.otel.endpoint）。
    try {
        const cfg = readSkillsConfig(api);
        initOtel("plugin", cfg.otelEndpoint);
    }
    catch {
        // guard: initOtel already catch-wraps internally; this outer try is a
        // belt-and-suspenders to ensure OTel can never break plugin registration.
    }
    registerStart(api);
    registerStop(api);
    registerPause(api);
    registerResume(api);
    registerSaveAsSkill(api);
    registerAnalyze(api);
    registerCancel(api);
    registerEvents(api);
    registerStatus(api);
    // 二期 F-B: list RPC 已删除,前端改调 listSkill (任务模板域);
    // 录制域不再需要 list (未完成录制由 start({}) 自动接力)
    registerResult(api);
    registerUpdatePrompt(api);
    registerDelete(api);
    registerRenderInstruction(api);
    registerSaveVideoToMount(api);
    registerGetRelayProgress(api);
    // 二期 F-B: 任务模板域 5 新 RPC
    registerListSkill(api);
    registerGetSkill(api);
    registerInvokeSkill(api);
    registerDeleteSkill(api);
    registerUpdateSkill(api);
}
//# sourceMappingURL=gateway.js.map