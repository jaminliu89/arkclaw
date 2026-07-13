import fs from "node:fs";
import path from "node:path";
/**
 * 微信 handoff 去重 hook（message_sending）—— 掐掉 openclaw outbound 对固定
 * `~/.openclaw/media/outbound/handoff.jpg` 的冗余发送。
 *
 * 背景（Direction B / change wechat-handoff-active-send 真机实测）：
 *   微信 handoff 现由 plugin 在 llm_output **主动** `sendWechatHandoffViaOpenClaw`
 *   发**唯一文件名** `handoff-fresh-<ts>.jpg`（已验证可用）。但 LLM 仍会输
 *   `MEDIA:~/.openclaw/media/outbound/handoff.jpg`，而 openclaw 标准 outbound 派发读的是
 *   **hook 前的 messagingToolSentTexts 副本**（attempt.ts），**不读 plugin 对 llm_output
 *   event 的 mutation** —— 故 `stripImHandoffMarkersFromEvent` 对微信无效，MEDIA 行照样
 *   到 outbound → 读固定 `handoff.jpg`。我们已不再写固定文件 → outbound 报 ENOENT
 *   （现象：正确图由主动发发出 + 多一条 ENOENT 报错）。
 *
 * 机制：openclaw-weixin `channel.sendMedia` 在真正读文件**之前**调
 *   `applyWeixinMessageSendingHook`（`message_sending` hook），若返回 `{cancel:true}`
 *   则直接 `return`（不 resolveLocalPath / 不读文件）→ 既不发也不 ENOENT。
 *
 * 判定：channel 含 "weixin" 且 mediaUrl basename === "handoff.jpg"（固定 MEDIA 路径）
 *   → cancel。主动发的 `handoff-fresh-<ts>.jpg`（basename 不等于 handoff.jpg）不匹配,
 *   照常发送。其它渠道（飞书等）不受影响（channel guard）。
 *
 * 永不抛错：handler 全程 try/catch,异常返回 undefined（= 不干预,正常发送）。
 */
const DEDUP_LOG_REL = [
    "extensions",
    "skill-switch",
    "wechat-handoff-dedup.log",
];
/** 固定 MEDIA 路径的 basename（主动发的 handoff-fresh-*.jpg 不匹配）。 */
function isFixedHandoffMedia(mediaUrl) {
    if (typeof mediaUrl !== "string" || mediaUrl.length === 0)
        return false;
    // 去掉 query/fragment 再取 basename
    const noQuery = mediaUrl.split(/[?#]/, 1)[0] ?? mediaUrl;
    const base = noQuery.substring(noQuery.lastIndexOf("/") + 1);
    return base === "handoff.jpg";
}
function appendLog(api, record) {
    try {
        const logPath = path.join(api.runtime.state.resolveStateDir(), ...DEDUP_LOG_REL);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
    }
    catch {
        /* never break */
    }
}
export function createWechatHandoffDedupHook(api) {
    return (event, _ctx) => {
        try {
            const meta = event?.metadata;
            const channel = typeof meta?.channel === "string" ? meta.channel : "";
            // 仅微信渠道(channel guard,防误伤飞书等)。R4(coco C1):放宽到 weixin|wechat
            // —— 实际 message_sending 的 channel 恒为 openclaw-weixin(CHANNEL_ID),但防御
            // 未来上游 channel id 变体(wechat / openclaw-wechat),避免 dedup 静默失效。
            if (!/(weixin|wechat)/i.test(channel))
                return undefined;
            const mediaUrls = Array.isArray(meta?.mediaUrls) ? meta.mediaUrls : [];
            if (!mediaUrls.some(isFixedHandoffMedia)) {
                // R2(agy MAJOR#1):pass-through 观测。预期 pass-through 是主动发的
                // handoff-fresh-*.jpg(放行正确)。若出现"含 handoff 却非 fresh-capture 且
                // basename 不等于 handoff.jpg"的 media 漏网(metadata 表示在未来版本变更导致
                // isFixedHandoffMedia 失配),记日志告警 —— 让"dedup 静默失效 → 双发"可观测。
                // 普通图片(不含 handoff)与正常主动发(handoff-fresh-*)不记,避免噪声。
                const unexpected = mediaUrls.filter((u) => typeof u === "string" &&
                    u.includes("handoff") &&
                    !/handoff-fresh-/.test(u));
                if (unexpected.length > 0) {
                    appendLog(api, {
                        action: "pass_through_unexpected_handoff",
                        channel,
                        mediaUrls: unexpected,
                    });
                }
                return undefined;
            }
            appendLog(api, {
                action: "cancel",
                reason: "redundant_fixed_handoff_outbound",
                channel,
                to: typeof event?.to === "string" ? event.to : undefined,
                mediaUrls,
            });
            // 掐掉 outbound 对固定 handoff.jpg 的冗余发送(plugin 已主动发唯一文件名图)。
            return {
                cancel: true,
                cancelReason: "wechat handoff already sent via plugin active-send (unique file); suppressing redundant fixed-file MEDIA dispatch to avoid double-send / ENOENT",
            };
        }
        catch {
            /* never break sending */
            return undefined;
        }
    };
}
//# sourceMappingURL=wechat-handoff-dedup-hook.js.map