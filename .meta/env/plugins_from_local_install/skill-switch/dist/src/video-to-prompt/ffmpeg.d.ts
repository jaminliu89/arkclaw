export interface SpawnFfmpegOptions {
    ffmpegBin: string;
    display: string;
    resolution: string;
    framerate: number;
    maxDurationSec: number;
    outputPath: string;
    logPath: string;
}
export interface SpawnFfmpegResult {
    pid: number;
}
export declare function spawnFfmpegRecording(opts: SpawnFfmpegOptions): Promise<SpawnFfmpegResult>;
export declare function isPidAlive(pid: number | undefined): boolean;
export interface StopFfmpegResult {
    stopped: boolean;
    sigintSent: boolean;
    sigkillSent: boolean;
}
export declare function stopFfmpegRecording(pid: number | undefined, opts?: {
    graceMs?: number;
}): Promise<StopFfmpegResult>;
export declare function probeVideoSize(videoPath: string): Promise<number | undefined>;
export interface WaitForFinalizedVideoOptions {
    timeoutMs?: number;
    stableIntervalMs?: number;
    minBytes?: number;
}
export interface FinalizedVideoInfo {
    sizeBytes: number;
    durationSec: number;
}
export declare function waitForFinalizedVideo(ffmpegBin: string, videoPath: string, opts?: WaitForFinalizedVideoOptions): Promise<FinalizedVideoInfo>;
export declare function probeVideoDuration(ffmpegBin: string, videoPath: string): Promise<number | undefined>;
/**
 * Pause an actively-recording ffmpeg process via SIGSTOP. The process freezes
 * including its capture loop, so ffmpeg's -t (duration) does not advance.
 * Resume with SIGCONT.
 */
export declare function pauseFfmpegRecording(pid: number | undefined): {
    paused: boolean;
    reason?: string;
};
export declare function resumeFfmpegRecording(pid: number | undefined): {
    resumed: boolean;
    reason?: string;
};
export declare function deleteVideoFile(videoPath: string): Promise<boolean>;
//# sourceMappingURL=ffmpeg.d.ts.map