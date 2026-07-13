import type { OpenClawPluginApi } from "./types.js";
/**
 * Wechat IM handoff retry hook —— **DISABLED（已被 Direction B 取代）**。
 *
 * 历史背景：原实现挂 `before_agent_finalize`，当微信 wait_for_user 回合 LLM **不输
 * `MEDIA:` 行**时，同步抓 fresh `handoff.jpg` 写入固定路径 + `action:"revise"` 让 LLM
 * 重出一份含 MEDIA 行的 reply，依赖 openclaw outbound 读固定文件发图。
 *
 * 为什么废弃（Direction B / change wechat-handoff-active-send）：
 *   - 微信发图已改为 plugin 在 `llm_output` **主动** `sendWechatHandoffViaOpenClaw`
 *     （唯一文件名）+ strip MEDIA，**source-driven**（CUA exec-event 走
 *     `markHandoffSource("cua")`、BUA 走 tool source），不再依赖 LLM 输 MEDIA。
 *     "LLM 漏 MEDIA" 这个本 hook 要解决的场景已被主动发覆盖。
 *   - 本 hook 的 `captureHandoffScreenshotInPlace()`（写固定 `handoff.jpg`）+ revise
 *     在 `before_agent_finalize` **生效的 openclaw 版本（≥2026.6.2）**会与主动发**双发**，
 *     并使"固定文件竞态根因消除"主张失效（coco 对抗评审 CRITICAL）。
 *     （目标版本 2026.5.28 该 hook 实测不触发 = inert，但升级即回归。）
 *
 * 处置：handler 改为**无条件 no-op**（永不 capture、永不 revise）。保留导出与
 * `before_agent_finalize` 注册仅为：① 不破坏 hook-timing-log.test.ts 的 timing 载体；
 * ② 若未来需要 before_agent_finalize 兜底，有现成挂载点。如确认永久不需要，可连同
 * `index.ts` 注册一并删除（会牵动 hook-timing 测试改用其它 sync hook）。
 */
export interface BeforeAgentFinalizeEvent {
    sessionId?: string;
    sessionKey?: string;
    lastAssistantMessage?: string;
    [k: string]: unknown;
}
export interface BeforeAgentFinalizeCtx {
    messageProvider?: unknown;
    sessionKey?: unknown;
    [k: string]: unknown;
}
export interface BeforeAgentFinalizeResult {
    action: "continue" | "revise" | "finalize";
    reason?: string;
    retry?: {
        instruction: string;
        idempotencyKey?: string;
        maxAttempts?: number;
    };
}
export declare function createWechatHandoffRetryHook(_api: OpenClawPluginApi): (_event: BeforeAgentFinalizeEvent, _ctx: BeforeAgentFinalizeCtx) => BeforeAgentFinalizeResult | undefined;
//# sourceMappingURL=wechat-handoff-retry-hook.d.ts.map