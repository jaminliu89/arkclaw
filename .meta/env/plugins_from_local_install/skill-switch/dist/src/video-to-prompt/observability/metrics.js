// VTP 二期 P4 可观测性 — plugin 侧 metric 真实实现 (Task 2.3)。
//
// L2 command.* 名集合 (skill-switch 通用 RPC 层):
//   - command.total       counter  {command, trigger, result}
//   - command.duration    histogram {command, trigger, result}  ms
//
// L3 vtp.* 业务名集合 (spec vtp-observability D-15 + R-T3):
//   counters:
//   - vtp.recording.total           {result: succeeded|failed|canceled}
//   - vtp.recording.start.total     {result}
//   - vtp.recording.delete.total            {result, source}
//   - vtp.recording.delete.mount_video.total {result: deleted|missing|unsafe|error|unknown, source}
//   - vtp.template.save.total               {result}
//   - vtp.template.update.total     {result}
//   - vtp.template.delete.total     {result}
//   - vtp.template.invocation.total {}   // F-5: trigger_source 删除 (cardinality=1 无信息)
//   - vtp.consolidate.fallback.total {reason}
//   histograms:
//   - vtp.recording.duration        ms, {result}
//   - vtp.recording.stop.latency    ms
//   - vtp.relay.duration            ms, {result}
//   - vtp.cleanup.unlinked_count    gauge-like histogram
//   - vtp.skill_index.entry_count   gauge-like histogram
import { metrics } from "@opentelemetry/api";
// ── L2 command.* (skill-switch RPC layer) ──────────────────────────────────
export const COMMAND_COUNTER_NAMES = ["command.total"];
export const COMMAND_HISTOGRAM_NAMES = ["command.duration"];
// ── L3 vtp.* (video-to-prompt business layer) ─────────────────────────────
export const VTP_COUNTER_NAMES = [
    "vtp.recording.total",
    "vtp.recording.start.total",
    "vtp.recording.delete.total",
    "vtp.recording.delete.mount_video.total",
    "vtp.template.save.total",
    "vtp.template.update.total",
    "vtp.template.delete.total",
    "vtp.template.invocation.total",
    "vtp.consolidate.fallback.total",
];
export const VTP_HISTOGRAM_NAMES = [
    "vtp.recording.duration",
    "vtp.recording.stop.latency",
    "vtp.relay.duration",
    "vtp.cleanup.unlinked_count",
    "vtp.skill_index.entry_count",
];
// Lazy instrument caches — populated on first use after OTel is initialized.
//
// M9 invariant: 首次 incrementCounter/recordHistogram 必须发生在 initOtel
// 之后。否则 getMeter() 返回 NOOP meter,创建出的 NOOP instrument 会被永久
// 缓存 —— 之后即便 OTel 初始化成功 metric 仍丢。当前 gateway.ts
// registerCuaRecordingGateway 在所有 registerX(api) / scheduler 启动之前
// 同步调 initOtel("plugin"),RPC handler 与调度器都晚于它触发 → 该 footgun
// 当前不会发生。改动初始化顺序前必须维持「initOtel 先于任何 metric 调用」。
const _counters = new Map();
const _histograms = new Map();
function getMeterInstance() {
    return metrics.getMeter("vtp");
}
/**
 * 公开 getMeter helper — 供 metrics.ts 外部按需创建 custom instrument。
 * 名称保持向后兼容 (旧 no-op 版本曾暴露此函数)。
 */
export function getMeter() {
    return getMeterInstance();
}
/**
 * increment a counter by 1.
 * Silent no-op if OTel has not been initialized (getMeter returns NOOP meter).
 */
export function incrementCounter(name, attrs) {
    try {
        let counter = _counters.get(name);
        if (!counter) {
            counter = getMeterInstance().createCounter(name);
            _counters.set(name, counter);
        }
        counter.add(1, attrs);
    }
    catch {
        // silent no-op — OTel not initialized or unreachable collector
    }
}
/**
 * record a histogram observation.
 * Silent no-op if OTel has not been initialized.
 */
export function recordHistogram(name, value, attrs) {
    try {
        let histogram = _histograms.get(name);
        if (!histogram) {
            histogram = getMeterInstance().createHistogram(name);
            _histograms.set(name, histogram);
        }
        histogram.record(value, attrs);
    }
    catch {
        // silent no-op
    }
}
//# sourceMappingURL=metrics.js.map