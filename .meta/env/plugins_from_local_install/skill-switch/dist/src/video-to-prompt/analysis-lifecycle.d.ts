import type { CommandResponse, OpenClawPluginApi, RecordingMetadata } from "./types.js";
import { type MetaArtifact, type PromptArtifact } from "./result-reader.js";
export declare function handleAnalyze(api: OpenClawPluginApi, recordingId: string | null): Promise<CommandResponse>;
/**
 * Cancel an in-progress analyze run. Mirrors handleAnalyze's gate pattern so
 * cancel and analyze on the same recordingId serialize. Kills the skill
 * subprocess (SIGTERM + 1s SIGKILL fallback), polls up to 3s for exit, removes
 * stale phase/events files, then patches the recording to terminal
 * status="canceled" with an explicit "canceled by user" marker.
 *
 * Zombie path (status=analyzing but skillPid not alive) is handled: kill is
 * skipped, but cleanup + terminal cancel patch still happen.
 */
export declare function handleCancelAnalysis(api: OpenClawPluginApi, recordingId: string): Promise<CommandResponse>;
export declare function handleStatus(api: OpenClawPluginApi, recordingId: string | null): Promise<CommandResponse>;
export declare function handleResult(api: OpenClawPluginApi, recordingId: string | null, opts: {
    includeLog: boolean;
    includeSteps: boolean;
}): Promise<CommandResponse>;
export { ACTION_ENUM } from "./prompt-normalize.js";
export interface UpdatePromptOptions {
    prompt: Record<string, unknown>;
    reindexSteps?: boolean;
}
export interface UpdatePromptResponse {
    type: "updated" | "error";
    text: string;
    recording?: RecordingMetadata;
    prompt?: PromptArtifact;
    meta?: MetaArtifact;
    revision?: number;
    bakCreated?: boolean;
    errorCode?: "INVALID_REQUEST" | "RECORDING_NOT_FOUND" | "PROMPT_NOT_FOUND" | "RECORDING_BUSY" | "PROMPT_VALIDATION_FAILED";
    errors?: string[];
}
export declare function handleUpdatePrompt(api: OpenClawPluginApi, recordingId: string | null, opts: UpdatePromptOptions): Promise<UpdatePromptResponse>;
//# sourceMappingURL=analysis-lifecycle.d.ts.map