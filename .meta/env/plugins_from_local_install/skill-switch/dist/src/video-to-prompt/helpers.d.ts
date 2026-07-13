import type { OpenClawPluginApi, RecordingMetadata } from "./types.js";
import type { invokeVideoToPromptSkill } from "./skill-invoker.js";
export declare function atomicWriteFileWithSync(target: string, data: string): Promise<void>;
export declare const DEFAULT_MAX_SECONDS = 120;
export declare const DEFAULT_GRACE_SECONDS = 10;
export declare const DEFAULT_FFMPEG = "ffmpeg";
export declare const DEFAULT_DISPLAY = ":99";
export declare const DEFAULT_RESOLUTION = "1920x1080";
export declare const DEFAULT_FRAMERATE = 15;
export declare const DEFAULT_MAX_SIZE_MB = 300;
export declare const ACTIVE_STATUSES: ReadonlySet<RecordingMetadata["status"]>;
/** @internal exported for unit tests */
export declare function resolveSkillScriptRoots(api: OpenClawPluginApi): string[];
/** @internal exported for unit tests */
export declare function validateSkillScriptPath(candidate: string, allowedRoots: string[]): Promise<{
    ok: true;
    resolved: string;
} | {
    ok: false;
    reason: string;
}>;
export declare function makeSkillExitWatchdog(api: OpenClawPluginApi, recordingId: string, promptDir: string): NonNullable<Parameters<typeof invokeVideoToPromptSkill>[0]["onExit"]>;
export declare function pluginConfig(api: OpenClawPluginApi): {
    maxSeconds: any;
    graceSec: any;
    maxSizeMB: any;
    ffmpegBin: any;
    display: any;
    resolution: any;
    framerate: number;
    skillScriptPath: any;
};
export declare function readSkillsConfig(api: OpenClawPluginApi): {
    vtpRecordingRoot: string;
    recordingRetentionDays: number;
    maxReferenceCount: number;
    relayTimeoutSeconds: number;
    skillIndexRebuildIntervalHours: number;
    otelEndpoint: string | undefined;
};
export declare function renderRecording(r: RecordingMetadata): string;
//# sourceMappingURL=helpers.d.ts.map