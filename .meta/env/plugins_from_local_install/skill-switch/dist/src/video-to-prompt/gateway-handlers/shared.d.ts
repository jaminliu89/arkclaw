import type { OpenClawPluginApi, GatewayContext, RecordingMetadata, RecordingView } from "../types.js";
export declare function respondError(ctx: GatewayContext, code: string, message: string, extra?: Record<string, unknown>): void;
export declare function redactError(_err: unknown): string;
export declare function viewOf(api: OpenClawPluginApi, recordingId: string, vtpHome?: string): Promise<RecordingView | null>;
export declare function viewOfRecording(api: OpenClawPluginApi, rec: RecordingMetadata | null | undefined): Promise<RecordingView | null>;
export declare const MAX_LOG_TAIL_BYTES: number;
//# sourceMappingURL=shared.d.ts.map