export declare const COMMAND_COUNTER_NAMES: readonly ["command.total"];
export declare const COMMAND_HISTOGRAM_NAMES: readonly ["command.duration"];
export declare const VTP_COUNTER_NAMES: readonly ["vtp.recording.total", "vtp.recording.start.total", "vtp.recording.delete.total", "vtp.recording.delete.mount_video.total", "vtp.template.save.total", "vtp.template.update.total", "vtp.template.delete.total", "vtp.template.invocation.total", "vtp.consolidate.fallback.total"];
export declare const VTP_HISTOGRAM_NAMES: readonly ["vtp.recording.duration", "vtp.recording.stop.latency", "vtp.relay.duration", "vtp.cleanup.unlinked_count", "vtp.skill_index.entry_count"];
type CounterName = (typeof COMMAND_COUNTER_NAMES)[number] | (typeof VTP_COUNTER_NAMES)[number];
type HistogramName = (typeof COMMAND_HISTOGRAM_NAMES)[number] | (typeof VTP_HISTOGRAM_NAMES)[number];
/**
 * 公开 getMeter helper — 供 metrics.ts 外部按需创建 custom instrument。
 * 名称保持向后兼容 (旧 no-op 版本曾暴露此函数)。
 */
export declare function getMeter(): import("@opentelemetry/api").Meter;
/**
 * increment a counter by 1.
 * Silent no-op if OTel has not been initialized (getMeter returns NOOP meter).
 */
export declare function incrementCounter(name: CounterName, attrs?: Record<string, string | number>): void;
/**
 * record a histogram observation.
 * Silent no-op if OTel has not been initialized.
 */
export declare function recordHistogram(name: HistogramName, value: number, attrs?: Record<string, string | number>): void;
export {};
//# sourceMappingURL=metrics.d.ts.map