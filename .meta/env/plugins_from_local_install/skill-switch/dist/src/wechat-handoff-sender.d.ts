/**
 * 微信 IM handoff 截图发送 —— 主动发图通道（对齐飞书 P1 设计）。
 *
 * 走 openclaw 官方 plugin SDK `deliverOutboundPayloads`(`openclaw/plugin-sdk/outbound-runtime`)
 * → openclaw 通用 outbound 层按 channel 名解析 handler → weixin channel(`id:"openclaw-weixin"`)
 * 的 `sendMedia`(`openclaw-weixin/src/channel.ts:225`)→ `resolveOutboundAccountId` +
 * `getContextToken` + `sendWeixinMediaFile`(CDN 加密上传链)→ 真发图。
 *
 * 设计动机:微信原本走「LLM 输 MEDIA:固定 handoff.jpg → openclaw outbound 读固定文件发」
 * 的竞态架构(plugin 抢在 outbound 读之前写固定文件),首次无旧图 → ENOENT,后续 → 旧图
 * (off-by-one)。改为与飞书对称的「唯一文件名 fresh 截图 + plugin 主动 deliverOutboundPayloads」
 * 后,完全不碰固定文件 → 竞态消失。channel 名经核实 = "openclaw-weixin"
 * (plugin id;normalizeMessageChannel 原样保留;registry 按 plugin.id === channel 匹配)。
 *
 * 关键不变量(与 im-handoff-sender.ts 飞书 sender 一致):
 *   - **永不抛错**:整个函数体 try/catch 全包,任何异常转 outcome="error" 返回
 *     → 满足 fire-and-forget caller 安全
 *   - **fail-fast on missing SDK export**:`deliverOutboundPayloads` 是静态 ESM named import,
 *     openclaw SDK 升级移除该 export 时本模块加载阶段直接 SyntaxError,plugin 整体启动 fail-fast
 *   - **结构化 outcome**:可观测失败原因
 *
 * 收件人 `to`:微信 DM 的 sessionKey 退化为 `agent:main:main`(无 open id),真实 weChat userId
 * 在 hook 的 `ctx.channelId`(由 caller 传入);weixin channel `sendMedia` 的 `ctx.to` 即此 userId,
 * 内部 `resolveOutboundAccountId(cfg, to)` 单账号直取、多账号经 contextToken 解析。
 *
 * Log 文件:`<stateDir>/extensions/skill-switch/wechat-handoff-sender.log`
 */
import type { OpenClawPluginApi } from "./types.js";
export interface SendWechatHandoffParams {
    api: OpenClawPluginApi;
    sessionKey: string;
    /** weChat userId（来自 hook ctx.channelId）。 */
    to: string;
    handoffPath: string;
    accountId?: string;
}
export interface SendWechatHandoffOutcome {
    outcome: "success" | "empty_results" | "error" | "skip_invalid_input" | "skip_handoff_missing";
    message_ids?: string[];
    error_message?: string;
}
export declare function sendWechatHandoffViaOpenClaw(params: SendWechatHandoffParams): Promise<SendWechatHandoffOutcome>;
//# sourceMappingURL=wechat-handoff-sender.d.ts.map