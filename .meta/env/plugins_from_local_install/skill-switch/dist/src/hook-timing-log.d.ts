export type HookTimingOpenClawApi = {
    id: string;
    version?: string | null;
};
export interface HookTimingLogLine {
    durationMs: number;
    hookName: string;
    pluginId: string;
    pluginVersion: string | null;
    startTimestamp: number;
    endTimestamp: number;
}
type HookTimingStream = {
    destroyed?: boolean;
    on(event: "error" | "warning", listener: (error: Error) => void): HookTimingStream;
    write(chunk: string, callback?: (error?: Error | null) => void): boolean;
    destroy(): void;
};
type HookTimingStreamFactory = (pluginId: string) => HookTimingStream;
export declare const HOOK_TIMING_LOG_DIR = "/var/log/openclaw_plugins_perf/hook_duration";
export declare const HOOK_TIMING_LOG_MAX_BYTES = "1M";
export declare const HOOK_TIMING_LOG_MAX_FILES = 2;
export declare class RotatingHookTimingLogWriter {
    private readonly streamFactory;
    private readonly streams;
    constructor(streamFactory?: HookTimingStreamFactory);
    private resetStream;
    private ensureStream;
    appendLine(pluginId: string, line: string): void;
}
export declare function logHookTiming(api: HookTimingOpenClawApi, hookName: string, startTimestamp: number, endTimestamp: number, writer?: RotatingHookTimingLogWriter): void;
export {};
//# sourceMappingURL=hook-timing-log.d.ts.map