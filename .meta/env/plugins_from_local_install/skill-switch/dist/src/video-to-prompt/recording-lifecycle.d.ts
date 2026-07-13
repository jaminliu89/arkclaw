import type { CommandResponse, OpenClawPluginApi } from "./types.js";
export declare function scheduleAutoStop(api: OpenClawPluginApi, recordingId: string, delaySec: number): void;
export declare function cancelAutoStop(recordingId: string): void;
export declare function releaseRecordingDisplayLockBest(stateDir: string, display: string): Promise<void>;
export declare function handleStart(api: OpenClawPluginApi): Promise<CommandResponse>;
export declare function handleStartWithinLifecycleGate(api: OpenClawPluginApi): Promise<CommandResponse>;
export declare function handleStop(api: OpenClawPluginApi, opts: {
    mode: "stop" | "cancel" | "analyze";
    autoTriggered?: boolean;
}): Promise<CommandResponse>;
export declare function handlePause(api: OpenClawPluginApi): Promise<CommandResponse>;
export declare function handleResume(api: OpenClawPluginApi): Promise<CommandResponse>;
//# sourceMappingURL=recording-lifecycle.d.ts.map