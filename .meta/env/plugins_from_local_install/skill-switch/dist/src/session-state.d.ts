import type { PluginCommandContext, SkillInfo } from "./types.js";
/**
 * 实例级全局 context key。skill-switch 已经从 session 级别迁移到实例级别:
 * `/skill-switch` 命令和 `arkclawSkillSelect.switch` gateway 不再按 session
 * 隔离 active skill,所有 session 共享同一个 active skill。指定 `--session`
 * / `sessionKey` 时忽略,仅做兼容处理。
 */
export declare const GLOBAL_CONTEXT_KEY = "__global__";
/**
 * 默认 active skill id。当 `getSessionActiveSkill` 在 state.json 中找不到对应
 * 条目时返回该值,作为实例级的兜底 skill。该 skill 由 install/upgrade 脚本
 * 安装到 workspace skills 目录;若未安装,后续的 `findSkillById` 仍会返回 null,
 * 调用方需自行处理。
 */
export declare const DEFAULT_ACTIVE_SKILL_ID = "XUA-auto";
export declare function buildContextKey(ctx: PluginCommandContext): string | null;
export declare function contextKeyFromSessionKey(sessionKey: string): string | null;
export declare function getSessionActiveSkill(stateDir: string, key: string): Promise<string | null>;
/**
 * 仅返回 state.json 中显式存储的 active skill id;未存储则返回 null。
 * 用于 list previous 等需要区分"用户曾显式选过"与"使用默认 fallback"
 * 的场景,不要在 prompt 注入路径里使用。
 */
export declare function getStoredActiveSkill(stateDir: string, key: string): Promise<string | null>;
export declare function hasStoredActiveSkillContext(stateDir: string, key: string): Promise<boolean>;
export declare function setSessionActiveSkill(stateDir: string, key: string, skillId: string | null): Promise<void>;
export declare function getCachedSkills(stateDir: string): Promise<SkillInfo[] | null>;
export declare function updateCachedSkills(stateDir: string, skills: SkillInfo[]): Promise<void>;
//# sourceMappingURL=session-state.d.ts.map