/**
 * 飞书 IM handoff 截图发送 — V0 P1 通道。
 *
 * 走 openclaw 官方 plugin SDK `deliverOutboundPayloads`(`openclaw/plugin-sdk/outbound-runtime`)
 * → openclaw 内部路由 channel="feishu" → `feishuOutbound.sendMedia`
 * (`openclaw-lark/src/messaging/outbound/outbound.ts:235`,正确传 mediaLocalRoots,
 * 无 V7 时代 Bug 2 reply-dispatcher.ts:351 漏传问题)→ 真发图。
 *
 * 详见 design doc:`docs/superpowers/specs/2026-05-28-im-handoff-feishu-p1-migration-design.md`
 * 的 D1 / D5 / §6.1 outcome 表 / §6.2 跨 channel 行为契约。
 *
 * 关键不变量:
 *   - **永不抛错**:整个函数体 try/catch 全包,任何异常转 outcome="error" 返回
 *     → 满足 fire-and-forget caller 安全(M4)
 *   - **fail-fast on missing SDK export**:`deliverOutboundPayloads` 是静态 ESM
 *     named import。openclaw SDK 升级移除该 export 时,本模块加载阶段直接 SyntaxError,
 *     plugin 整体启动 fail-fast,监控立即报警 → 不需要 runtime capability guard
 *     的 silent skip。详见 design doc §9.4 "V0 → V1 SDK upgrade SOP"。
 *   - **结构化 outcome**:替代 V7 boolean 返回,可观测失败原因(M2)
 *
 * Log 文件:`<stateDir>/extensions/skill-switch/feishu-handoff-sender.log`
 * (沿用 V7 log 文件名便于 cross-version grep 对照)
 */
import type { OpenClawPluginApi } from "./types.js";
export interface SendFeishuHandoffParams {
    api: OpenClawPluginApi;
    sessionKey: string;
    openId: string;
    handoffPath: string;
    accountId?: string;
}
export interface SendFeishuHandoffOutcome {
    outcome: "success" | "empty_results" | "error" | "skip_invalid_input" | "skip_handoff_missing";
    message_ids?: string[];
    error_message?: string;
}
/**
 * 从 sessionKey 抽取飞书 user open_id(DM only)。
 *
 * 实测格式:`agent:main:feishu:default:direct:ou_<32 hex>`。
 * 取首个 `ou_` token,group/chat (`oc_*`) 不匹配(返回 null 让 caller 跳过 — V0 仅
 * 覆盖 DM 场景)。
 */
export declare function parseFeishuOpenIdFromSessionKey(sessionKey: string | undefined | null): string | null;
export declare function sendFeishuHandoffViaOpenClaw(params: SendFeishuHandoffParams): Promise<SendFeishuHandoffOutcome>;
//# sourceMappingURL=im-handoff-sender.d.ts.map