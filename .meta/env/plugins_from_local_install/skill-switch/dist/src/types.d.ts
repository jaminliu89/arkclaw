export type SkillSource = "builtin" | "session" | "workspace" | "plugin";
export type HookLogKind = "before_tool_call" | "after_tool_call" | "llm_input" | "llm_output";
export interface HookLogRecord {
    ts: string;
    hook: HookLogKind;
    traceId?: string | null;
    sessionKey?: string | null;
    toolName?: string | null;
    injectedSession?: boolean;
    durationMs?: number | null;
    outcome?: string | null;
    summary?: Record<string, unknown>;
}
export type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export { getNonEmptyString, resolveSessionId, resolveSessionKey, parseSessionKeyFromArgs } from "./utils.js";
export interface SkillInfo {
    id: string;
    name: string;
    description?: string;
    source: SkillSource;
    pluginId?: string;
    path: string;
}
export interface InjectionConfig {
    lowPrioritySkills: string[];
}
export interface ActiveSkillOverride {
    skillId: string | null;
    switchedAt: string;
    mode: "manual";
}
export interface CommandResponse {
    text: string;
    type: "list" | "switched" | "cleared" | "focused" | "error" | "help";
    skills?: SkillInfo[];
    activeSkill?: SkillInfo | null;
}
export interface HistoryCleanResult {
    cleanedCount: number;
    lastUserMessage: any | null;
}
export interface AgentMessage {
    content?: string | any[];
}
export interface PluginCommandDefinition {
    name: string;
    description: string;
    acceptsArgs?: boolean;
    requireAuth?: boolean;
    handler: (ctx: PluginCommandContext) => any;
}
export interface PluginCommandContext {
    channel?: string;
    from?: string;
    to?: string;
    accountId?: string;
    /** Session identifier (secondary, see sessionKey for primary) */
    sessionId?: string;
    /** Session key identifier (primary identifier used by OpenClaw) */
    sessionKey?: string;
    isAuthorizedSender: boolean;
    commandBody: string;
    config: any;
    args?: string;
    requestConversationBinding: () => void;
    detachConversationBinding: () => void;
    getCurrentConversationBinding: () => any;
}
//# sourceMappingURL=types.d.ts.map