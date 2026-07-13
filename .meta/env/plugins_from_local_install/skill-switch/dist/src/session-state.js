import fs from "node:fs/promises";
import path from "node:path";
const STATE_REL_PATH = ["extensions", "skill-switch", "state.json"];
/**
 * 实例级全局 context key。skill-switch 已经从 session 级别迁移到实例级别:
 * `/skill-switch` 命令和 `arkclawSkillSelect.switch` gateway 不再按 session
 * 隔离 active skill,所有 session 共享同一个 active skill。指定 `--session`
 * / `sessionKey` 时忽略,仅做兼容处理。
 */
export const GLOBAL_CONTEXT_KEY = "__global__";
/**
 * 默认 active skill id。当 `getSessionActiveSkill` 在 state.json 中找不到对应
 * 条目时返回该值,作为实例级的兜底 skill。该 skill 由 install/upgrade 脚本
 * 安装到 workspace skills 目录;若未安装,后续的 `findSkillById` 仍会返回 null,
 * 调用方需自行处理。
 */
export const DEFAULT_ACTIVE_SKILL_ID = "XUA-auto";
function resolveStatePath(stateDir) {
    return path.join(stateDir, ...STATE_REL_PATH);
}
export function buildContextKey(ctx) {
    const parts = [];
    if (ctx.channel) {
        parts.push(ctx.channel);
    }
    if (ctx.from) {
        parts.push(ctx.from);
    }
    if (ctx.accountId) {
        parts.push(ctx.accountId);
    }
    if (parts.length === 0) {
        return null;
    }
    return parts.join(":");
}
export function contextKeyFromSessionKey(sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length < 3) {
        return null;
    }
    if (parts[0] !== "agent") {
        return null;
    }
    return parts.slice(2).join(":");
}
async function readState(statePath) {
    try {
        const raw = await fs.readFile(statePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.version === 1 && typeof parsed.contexts === "object") {
            return parsed;
        }
    }
    catch {
    }
    return { version: 1, contexts: {} };
}
async function writeState(statePath, state) {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}
export async function getSessionActiveSkill(stateDir, key) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    const override = state.contexts[key];
    // context 不存在时回退到默认 skill (XUA-auto);context 存在但 skillId
    // 为 null 时表示用户显式清理,不再回退默认。
    if (override === undefined)
        return DEFAULT_ACTIVE_SKILL_ID;
    return override.skillId;
}
/**
 * 仅返回 state.json 中显式存储的 active skill id;未存储则返回 null。
 * 用于 list previous 等需要区分"用户曾显式选过"与"使用默认 fallback"
 * 的场景,不要在 prompt 注入路径里使用。
 */
export async function getStoredActiveSkill(stateDir, key) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    const override = state.contexts[key];
    return override?.skillId ?? null;
}
export async function hasStoredActiveSkillContext(stateDir, key) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    return Object.prototype.hasOwnProperty.call(state.contexts, key);
}
export async function setSessionActiveSkill(stateDir, key, skillId) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    if (skillId === null) {
        state.contexts[key] = {
            skillId: null,
            switchedAt: new Date().toISOString(),
            mode: "manual",
        };
    }
    else {
        state.contexts[key] = {
            skillId,
            switchedAt: new Date().toISOString(),
            mode: "manual",
        };
    }
    await writeState(statePath, state);
}
export async function getCachedSkills(stateDir) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    return state.cachedSkills?.skills ?? null;
}
export async function updateCachedSkills(stateDir, skills) {
    const statePath = resolveStatePath(stateDir);
    const state = await readState(statePath);
    state.cachedSkills = {
        skills,
        updatedAt: new Date().toISOString(),
    };
    await writeState(statePath, state);
}
//# sourceMappingURL=session-state.js.map