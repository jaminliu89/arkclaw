import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionActiveSkill, GLOBAL_CONTEXT_KEY, getCachedSkills, DEFAULT_ACTIVE_SKILL_ID, } from "./session-state.js";
import { findSkillById } from "./skill-discovery.js";
import { detectConversationSource, renderConversationSourceLine, } from "./conversation-source.js";
/** Diagnostic log path (mirrors bua-hook.log pattern). */
const SKILL_INJECTION_LOG_REL = [
    "extensions",
    "skill-switch",
    "skill-injection-hook.log",
];
function appendDiag(api, record) {
    try {
        const logPath = path.join(api.runtime.state.resolveStateDir(), ...SKILL_INJECTION_LOG_REL);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
    }
    catch {
        // Never break the hook because of diagnostic logging.
    }
}
export const SKILL_OVERRIDE_MARKER_START = "[SKILL-SWITCH OVERRIDE]";
export const SKILL_OVERRIDE_MARKER_END = "[/SKILL-SWITCH OVERRIDE]";
export const SKILL_AVAILABLE_MARKER_START = "[SKILL-SWITCH AVAILABLE]";
export const SKILL_AVAILABLE_MARKER_END = "[/SKILL-SWITCH AVAILABLE]";
const DEFAULT_LOW_PRIORITY_SKILLS = ["XUA-auto"];
function getDefaultActiveSkillPath() {
    return path.join(process.env.HOME || os.homedir(), ".agents", "skills", DEFAULT_ACTIVE_SKILL_ID, "SKILL.md");
}
/**
 * 读取默认 `XUA-auto` skill 并构造一个临时 SkillInfo。
 * 当缓存里找不到目标 skill(典型场景:首次启动还没扫描过 skills,而 active
 * skill 已经回退为 DEFAULT_ACTIVE_SKILL_ID = XUA-auto)时,直接按
 * `$HOME/.agents/skills/XUA-auto/SKILL.md` 兜底。
 */
function loadDefaultSkillFromAgentsDir() {
    try {
        const skillPath = getDefaultActiveSkillPath();
        if (!fs.existsSync(skillPath))
            return null;
        let name = DEFAULT_ACTIVE_SKILL_ID;
        let description;
        try {
            const content = fs.readFileSync(skillPath, "utf-8");
            const titleMatch = content.match(/^#\s+(.+)$/m);
            if (titleMatch)
                name = titleMatch[1].trim();
            const descMatch = content.match(/^#\s+.+\n\n(.+?)(?:\n\n|$)/s);
            if (descMatch)
                description = descMatch[1].trim().slice(0, 200);
        }
        catch { }
        return {
            id: DEFAULT_ACTIVE_SKILL_ID,
            name,
            description,
            source: "workspace",
            path: skillPath,
        };
    }
    catch {
        return null;
    }
}
function readSkillContent(skillInfo) {
    const skillMdPath = skillInfo.path;
    if (!skillMdPath || !skillMdPath.endsWith("SKILL.md")) {
        return (skillInfo.description ?? `Use the ${skillInfo.name} skill for this task.`);
    }
    try {
        return fs.readFileSync(skillMdPath, "utf-8").trim();
    }
    catch {
        return (skillInfo.description ?? `Use the ${skillInfo.name} skill for this task.`);
    }
}
function readInjectionConfig(api) {
    const cfg = api.config
        ?.injection;
    const configured = cfg?.lowPrioritySkills;
    if (!Array.isArray(configured)) {
        return { lowPrioritySkills: DEFAULT_LOW_PRIORITY_SKILLS };
    }
    return {
        lowPrioritySkills: configured.filter((value) => typeof value === "string" && value.length > 0),
    };
}
/**
 * before_prompt_build hook.
 *
 * Two independent jobs, joined into one return:
 *
 *  (a) Conversation-source marker — fires for ANY session whose source is IM.
 *      Tells the main-reply LLM that the user is on an IM channel, so it
 *      should pick the IM branch in SKILL.md (when present). Without this,
 *      LLM sees SKILL.md as-is and defaults to the Web branch — which is
 *      exactly the bug we hit when wechat received Web-style handoff text.
 *      Web source: NO marker injected (LLM keeps default Web behaviour).
 *
 *  (b) Skill injection — fires when an active skill resolves to a known
 *      SkillInfo. High-priority skills are injected as the preferred approach;
 *      configured low-priority skills are appended only as available skill
 *      directory entries.
 *
 * The two jobs are independent: (a) can fire without (b), and vice versa.
 */
export function createSkillInjectionHook(api) {
    return async (_event, ctx) => {
        const sessionKey = ctx.sessionKey;
        const source = detectConversationSource(ctx);
        // Job (a): conversation-source marker. Only inject for IM — Web stays default.
        const sourceMarker = source === "im"
            ? [
                "",
                "[CONVERSATION SOURCE]",
                renderConversationSourceLine(source),
                "[/CONVERSATION SOURCE]",
                "",
            ].join("\n")
            : "";
        // Job (b): skill injection (instance-level, applies to all sessions).
        // getSessionActiveSkill 内部已对未选定情况兜底为 DEFAULT_ACTIVE_SKILL_ID
        // (XUA-auto)。如果缓存里找不到对应 skill,再尝试从约定路径
        // `$HOME/.agents/skills/XUA-auto/SKILL.md` 读取。
        let overrideBlock = "";
        let overrideContextHint = "";
        let resolvedSkillId = null;
        let resolvedFromDisk = false;
        let injectionTier = "none";
        {
            const injectionConfig = readInjectionConfig(api);
            const lowPrioritySkills = new Set(injectionConfig.lowPrioritySkills);
            const stateDir = api.runtime.state.resolveStateDir();
            const activeSkillId = await getSessionActiveSkill(stateDir, GLOBAL_CONTEXT_KEY);
            const cachedSkills = await getCachedSkills(stateDir);
            let skillInfo = activeSkillId
                ? findSkillById(cachedSkills ?? [], activeSkillId)
                : null;
            if (!skillInfo && activeSkillId === DEFAULT_ACTIVE_SKILL_ID) {
                skillInfo = loadDefaultSkillFromAgentsDir();
                if (skillInfo)
                    resolvedFromDisk = true;
            }
            if (skillInfo) {
                resolvedSkillId = skillInfo.id;
                if (lowPrioritySkills.has(skillInfo.id)) {
                    injectionTier = "low";
                    overrideBlock = buildSkillAvailableBlock(readSkillContent(skillInfo));
                }
                else {
                    injectionTier = "high";
                    overrideBlock = buildSkillOverrideBlock(skillInfo, readSkillContent(skillInfo));
                    overrideContextHint = `${skillInfo.id} (in system prompt) is the preferred skill`;
                }
            }
        }
        appendDiag(api, {
            hook: "before_prompt_build",
            has_sessionKey: !!sessionKey,
            session_third_segment: sessionKey
                ? (sessionKey.split(":")[2] ?? null)
                : null,
            messageProvider: ctx?.messageProvider ?? null,
            ctx_channelId: ctx?.channelId ?? null,
            ctx_keys: ctx ? Object.keys(ctx) : [],
            source,
            marker_injected: !!sourceMarker,
            override_injected: !!overrideBlock,
            injection_tier: injectionTier,
            resolved_skill_id: resolvedSkillId,
            resolved_from_disk: resolvedFromDisk,
        });
        if (!sourceMarker && !overrideBlock)
            return;
        return {
            appendSystemContext: `${sourceMarker}${overrideBlock}`,
            ...(overrideContextHint ? { prependContext: overrideContextHint } : {}),
        };
    };
}
function buildSkillOverrideBlock(skillInfo, content) {
    const { name, id } = skillInfo;
    return [
        "",
        SKILL_OVERRIDE_MARKER_START,
        `Selected skill: "${name}" (id: ${id})`,
        "",
        `**IMPORTANT: Treat skill "${id}" as the preferred approach for this request.**`,
        `- Start by considering how skill "${id}" can solve the user's request`,
        `- Use skill "${id}" tools and patterns as your first choice`,
        `- If skill "${id}" cannot accomplish the task safely or completely, fall back to other applicable skills or tools`,
        `- Follow skill "${id}" guidelines and conventions strictly`,
        "",
        content,
        SKILL_OVERRIDE_MARKER_END,
        "",
    ].join("\n");
}
function buildSkillAvailableBlock(content) {
    return [
        "",
        SKILL_AVAILABLE_MARKER_START,
        content,
        SKILL_AVAILABLE_MARKER_END,
        "",
    ].join("\n");
}
//# sourceMappingURL=skill-injection-hook.js.map