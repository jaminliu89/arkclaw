export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export type RecordingStatus = "recording" | "paused" | "stopped" | "analyzing" | "succeeded" | "failed" | "canceled";
export interface RecordingMetadata {
    recordingId: string;
    startedAt: string;
    endedAt?: string;
    status: RecordingStatus;
    videoPath: string;
    promptDir: string;
    ffmpegPid?: number;
    skillPid?: number;
    pausedAt?: string;
    pausedDurationMs?: number;
    resolution: string;
    framerate: number;
    display: string;
    maxDurationSec: number;
    durationSec?: number;
    sizeBytes?: number;
    taskName?: string;
    savedSkills?: SavedSkillRef[];
    error?: string;
}
export interface RecordingStateFile {
    version: 1;
    activeRecordingId: string | null;
    recordings: Record<string, RecordingMetadata>;
}
export interface SavedSkillRef {
    scope: "vtp-reference";
    path: string;
    slug: string;
}
export interface RecordingInvocations {
    rpcCall: string;
}
export interface RecordingView {
    recordingId: string;
    status: RecordingStatus;
    startedAt: string | null;
    endedAt: string | null;
    durationSec: number | null;
    sizeBytes: number | null;
    resolution: string | null;
    format: string | null;
    videoPath: string | null;
    videoExists: boolean;
    promptDir: string | null;
    taskName: string | null;
    promptPreview: string | null;
    confidence: number | null;
    savedSkills: SavedSkillRef[];
    invocations: RecordingInvocations | null;
    source: "state" | "reference";
    ffmpegAlive: boolean;
    skillAlive: boolean;
    error: string | null;
    resumedFromExisting?: boolean;
    videoRelayStatus?: "not_enabled" | "pending" | "completed" | "failed";
    videoMountRelativePath?: string | null;
    videoMountFullPath?: string | null;
    videoRelayError?: {
        code: string;
        message: string;
    } | null;
    videoRelayProgress?: number | null;
    keepVideoOnMount?: boolean;
    phaseDetail?: {
        phase: string;
        phaseProgress: number;
        totalProgressPct: number;
    } | null;
    promptError?: {
        code: string;
        message: string;
    } | null;
}
export interface CommandResponse {
    text: string;
    type: "started" | "stopped" | "status" | "result" | "list" | "error" | "help";
    recording?: RecordingMetadata | null;
    prompt?: unknown;
    noop?: boolean;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
}
export interface PluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => Promise<CommandResponse> | CommandResponse;
}
export interface PluginCommandContext {
    channel?: string;
    from?: string;
    to?: string;
    accountId?: string;
    isAuthorizedSender: boolean;
    commandBody: string;
    config: any;
    args?: string;
    requestConversationBinding: () => void;
    detachConversationBinding: () => void;
    getCurrentConversationBinding: () => any;
}
export interface GatewayContext {
    params: Record<string, any>;
    respond: (ok: boolean, data?: any, error?: {
        code: string;
        message: string;
        [key: string]: any;
    }) => void;
}
export type GatewayHandler = (ctx: GatewayContext) => Promise<void> | void;
export interface SkillView {
    slug: string;
    name: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    sourceRecordingId: string;
}
export interface SkillDetail extends SkillView {
    prompt: {
        taskName: string;
        description?: string;
        preconditions?: string[];
        steps: Array<{
            index: number;
            [k: string]: unknown;
        }>;
        expectedResult?: string;
        confidence?: number;
        source: Record<string, unknown>;
        createdAt: string;
    };
}
export interface RelayStateFile {
    status: "init" | "pending" | "completed" | "failed";
    mountRelativePath?: string;
    mountAbsolutePath?: string;
    mountRootRealPath?: string;
    errorCode?: string;
    errorMessage?: string;
    startedAt?: string;
    completedAt?: string;
    keepVideoOnMount: boolean;
    progress?: number;
    evicted?: boolean;
}
//# sourceMappingURL=types.d.ts.map