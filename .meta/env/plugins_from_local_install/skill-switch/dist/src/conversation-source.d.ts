/**
 * 对话来源判定。
 *
 * 历史:
 * - v1-v3: 用 ctx.messageProvider 判定 — 黑名单 "webchat"、其他都判 IM。
 *   实测发现 openclaw 在 outbound 路径(before_prompt_build hook 所在路径)+
 *   sessionKey 存在时永远不传 messageProvider(`deliver.ts:1370` /
 *   `outbound-send-service.ts:139` / `message-action-runner.ts:1357` 都是
 *   `sessionKey ? undefined : channel` 模式)。所以 messageProvider 永远
 *   undefined,所有场景兜底为 web,IM 分支永远不触发,前 7 commits 改的
 *   SKILL.md IM 分支文案从未在真 IM channel 验证过。
 * - v4(2026-05-25): 改用 sessionKey 第三段 prefix 解析 channel name,
 *   白名单(feishu / discord / slack / telegram / wechat / ...)匹配才判 im,
 *   其他(webchat / 未知 channel / sessionKey 缺失)**兜底 web**。
 *   Web 是先有代码 + 已实测稳的分支,未识别情况走 Web 是工程基本原则
 *   (用户的明确 push back:渠道识别不上时用稳的 fallback,不要让新代码
 *   无差别接管所有 channel)。
 *
 * sessionKey 格式参考:
 *   agent:main:web-a225ff82-b39c-...    → webchat,判 web
 *   agent:main:feishu-<chat-id>          → 飞书 IM,判 im(假设上游命名)
 *   agent:main:demo-channel:group:dev    → 未知 channel,兜底 web
 *
 * 上游 channel 命名可能调整;实测发现新 channel 没识别,扩充
 * IM_CHANNEL_PREFIXES 列表即可,不动判定逻辑。
 */
export type ConversationSource = "im" | "web";
export declare function detectConversationSource(ctx: {
    messageProvider?: string;
    sessionKey?: string;
}): ConversationSource;
/** 渲染注入 prompt 的来源标记行。 */
export declare function renderConversationSourceLine(source: ConversationSource): string;
//# sourceMappingURL=conversation-source.d.ts.map