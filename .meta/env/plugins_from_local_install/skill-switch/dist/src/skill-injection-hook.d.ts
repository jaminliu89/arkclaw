import type { OpenClawPluginApi } from "./types.js";
export declare const SKILL_OVERRIDE_MARKER_START = "[SKILL-SWITCH OVERRIDE]";
export declare const SKILL_OVERRIDE_MARKER_END = "[/SKILL-SWITCH OVERRIDE]";
export declare const SKILL_AVAILABLE_MARKER_START = "[SKILL-SWITCH AVAILABLE]";
export declare const SKILL_AVAILABLE_MARKER_END = "[/SKILL-SWITCH AVAILABLE]";
type BeforePromptBuildResult = {
    appendSystemContext?: string;
    prependContext?: string;
};
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
export declare function createSkillInjectionHook(api: OpenClawPluginApi): (_event: {
    prompt: string;
    messages: unknown[];
}, ctx: {
    sessionKey?: string;
    messageProvider?: string;
    channelId?: string;
}) => Promise<BeforePromptBuildResult | void>;
export {};
//# sourceMappingURL=skill-injection-hook.d.ts.map