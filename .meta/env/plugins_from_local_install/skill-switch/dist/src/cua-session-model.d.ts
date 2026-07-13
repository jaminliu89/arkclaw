import type { OpenClawPluginApi } from "./types.js";
export type SessionModelSnapshot = {
    sessionId: string;
    scope: "web";
    provider: string;
    modelId: string;
    apiKey: string;
    baseUrl: string;
    observedAt: string;
};
export type CaptureOutcome = {
    kind: "captured";
    snapshot: SessionModelSnapshot;
} | {
    kind: "skipped";
    reason: "non_web" | "no_session" | "no_model";
} | {
    kind: "fallback";
    reason: "invalid_model_spec" | "provider_missing" | "provider_config_missing" | "api_key_missing" | "base_url_missing" | "unknown_error";
};
export type CuaCommandInjectionResult = {
    command: string;
    injected: boolean;
    reason: "captured" | "no_cache" | "explicit_args" | "not_run" | "no_session";
};
export declare function captureSessionModelFromLlmInput(api: OpenClawPluginApi, event: unknown, ctx: unknown): CaptureOutcome;
export declare function getSessionModelSnapshot(sessionId: string | null | undefined): SessionModelSnapshot | null;
export declare function buildCuaOverrideArgv(sessionId: string | null | undefined): string[];
export declare function injectCuaOverrideIntoCommand(command: string, sessionId: string | null | undefined, escapeShellArg: (arg: string) => string): CuaCommandInjectionResult;
export declare function resetSessionModelCacheForTests(): void;
//# sourceMappingURL=cua-session-model.d.ts.map