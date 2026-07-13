import type { OpenClawPluginApi } from "./types.js";
export declare function resetImHandoffCycleForSession(sessionKey: string): void;
export declare function createLlmOutputDiagHook(api: OpenClawPluginApi): (event: any, ctx: any) => Promise<void>;
export declare function createLlmInputDiagHook(api: OpenClawPluginApi): (event: any, ctx: any) => Promise<void>;
//# sourceMappingURL=llm-input-diag-hook.d.ts.map