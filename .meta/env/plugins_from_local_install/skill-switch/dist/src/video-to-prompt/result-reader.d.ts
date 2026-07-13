import type { OpenClawPluginApi } from "./types.js";
export interface PromptArtifact {
    taskName?: string;
    description?: string;
    preconditions?: string[];
    steps?: Array<{
        stepIndex: number;
        action: string;
        target?: string;
        description?: string;
        screenshot_ref?: string;
        confidence?: number;
    }>;
    expectedResult?: string;
    confidence?: number;
    source?: Record<string, unknown>;
    usage?: Record<string, unknown>;
    createdAt?: string;
    qualityNotice?: string;
    [key: string]: unknown;
}
export interface MetaArtifact {
    recordingId?: string;
    videoPath?: string;
    videoDurationSec?: number;
    supportsVideo?: boolean;
    supportsImage?: boolean;
    modelId?: string;
    startedAt?: string;
    finishedAt?: string;
    status?: "succeeded" | "failed" | "running" | "canceled";
    error?: string;
    editedAt?: string;
    editedRevisions?: number;
    [key: string]: unknown;
}
export interface ReadResultOptions {
    promptDir: string;
    includeLog?: boolean;
    includeSteps?: boolean;
}
export interface PromptResult {
    prompt: PromptArtifact | null;
    meta: MetaArtifact | null;
    steps: unknown[] | null;
    log: string | null;
    available: {
        prompt: boolean;
        meta: boolean;
        steps: boolean;
        log: boolean;
    };
}
export declare function readPromptResult(opts: ReadResultOptions): Promise<PromptResult>;
export declare function promptDirForRecording(recordingId: string, api?: OpenClawPluginApi | null): string;
/**
 * Atomically write a new prompt.json, backing up the previous file to prompt.json.bak.
 * Caller owns validation — this function only does filesystem I/O.
 *
 * Behavior:
 *   1. If prompt.json exists, copy it to prompt.json.bak (single-slot backup, overwritten each time).
 *   2. Write new content to prompt.json.tmp, then rename to prompt.json.
 *
 * Returns { bakCreated: boolean } so the caller can surface whether a rollback target exists.
 */
export declare function writePromptFile(promptDir: string, prompt: Record<string, unknown>): Promise<{
    bakCreated: boolean;
}>;
/**
 * Write meta.json. Caller passes the full merged meta object.
 */
export declare function writeMetaFile(promptDir: string, meta: MetaArtifact): Promise<void>;
export declare function videoPathForRecording(recordingId: string, api?: OpenClawPluginApi | null): string;
//# sourceMappingURL=result-reader.d.ts.map