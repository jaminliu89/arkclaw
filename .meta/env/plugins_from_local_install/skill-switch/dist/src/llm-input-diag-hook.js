import fs from "node:fs";
import path from "node:path";
import { captureFreshHandoffScreenshot } from "./cua_commands.js";
import { parseFeishuOpenIdFromSessionKey, sendFeishuHandoffViaOpenClaw, } from "./im-handoff-sender.js";
import { sendWechatHandoffViaOpenClaw } from "./wechat-handoff-sender.js";
import { detectConversationSource } from "./conversation-source.js";
import { captureSessionModelFromLlmInput } from "./cua-session-model.js";
import { consumeRecentHandoffSource, getRecentHandoffSource, markHandoffSource, } from "./handoff-source.js";
/**
 * Diagnostic-only hook to dump what the LLM actually sees.
 *
 * Purpose: confirm whether the `[CONVERSATION SOURCE]` marker injected by
 * skill-injection-hook actually reaches the LLM. The before_prompt_build
 * hook's return value is supposed to be prepended to system prompt, but we
 * have no end-to-end verification — wechat output suggests Doubao isn't
 * following the marker, which could mean either:
 *
 *  (a) Marker reaches LLM but Doubao ignores it (need stronger prompt
 *      engineering, or modify cua tool output source-level)
 *  (b) Marker is silently dropped by openclaw before LLM call (plugin SDK
 *      issue, need different injection method)
 *
 * This hook fires on `llm_input` (conversation hook, requires
 * `allowConversationAccess: true` which is already set via install.sh).
 * It writes one line per LLM call to im-llm-input.log under stateDir.
 */
const LLM_INPUT_LOG_REL = ["extensions", "skill-switch", "im-llm-input.log"];
const MARKER = "[CONVERSATION SOURCE]";
const SAMPLE_LEN = 400;
const IM_HANDOFF_FALLBACK_TEXT = "好的，完成后告诉我，我继续任务。";
const HANDOFF_CYCLE_TTL_MS = 60 * 60_000;
/**
 * openclaw upstream heartbeat-runner 在 background command 完成时触发的
 * 独立 LLM 回合的 messageProvider 字段值。
 *
 * 上游来源:`openclaw/src/infra/heartbeat-runner.ts` —
 *   - L1646 附近 `Provider:` 字段赋值 `hasExecCompletion ? "exec-event" : ...`
 *     (这是 plugin 实际看到的 ctx.messageProvider 来源,精确位置)
 *   - L925 / L947 `isExecEventWake` 派生 helper(同字面量)
 * 行号会随上游 edit 漂移,认 `Provider:` 字段赋值这个**语义位置**为准,
 * 不认行号本身。
 *
 * 如果上游改名(如 "exec_event" / "execEvent"),本 plugin 的 Bug A 路径
 * (exec-event 入口 mark cua source)会静默失效 → 升级 openclaw 时必须
 * grep `EXEC_EVENT_PROVIDER` 确认。
 */
const EXEC_EVENT_PROVIDER = "exec-event";
const handoffCycleBySession = new Map();
/**
 * sessionKey 第三段是否是飞书 channel(prefix-tolerant)。
 *
 * openclaw 上游 `src/routing/session-key.ts:197-249` buildAgentPeerSessionKey 当前
 * 只产 colon-separated 第三段(`agent:main:feishu:default:direct:ou_xxx` 等 5 种)。
 * 这里与 `conversation-source.ts:77` extractImChannelFromSessionKey 的 prefix-match
 * 兜底哲学保持一致 — 未来上游若改名为 `agent:main:feishu-<chat-id>` 这种 dash 第三段,
 * exec-event 回合(messageProvider 不是 "feishu")的真飞书会话仍能被正确识别,
 * recentHandoffSource / 发图链路不会被错过。
 *
 * 严格匹配 `feishu` / `feishu-...` / `feishu_...`,拒绝 `feishuxx` 避免误吞。
 */
function isFeishuChannelSessionKey(sessionKey) {
    const parts = sessionKey.split(":");
    if (parts.length < 3 || parts[0] !== "agent")
        return false;
    const third = parts[2].toLowerCase();
    return (third === "feishu" ||
        third.startsWith("feishu-") ||
        third.startsWith("feishu_"));
}
function purgeExpiredHandoffCycles() {
    const now = Date.now();
    for (const [sessionKey, state] of handoffCycleBySession) {
        if (state.expiresAt <= now)
            handoffCycleBySession.delete(sessionKey);
    }
}
function getHandoffCycleState(sessionKey) {
    purgeExpiredHandoffCycles();
    const existing = handoffCycleBySession.get(sessionKey);
    if (existing) {
        existing.expiresAt = Date.now() + HANDOFF_CYCLE_TTL_MS;
        return existing;
    }
    const state = {
        generation: 0,
        sentGeneration: null,
        expiresAt: Date.now() + HANDOFF_CYCLE_TTL_MS,
    };
    handoffCycleBySession.set(sessionKey, state);
    return state;
}
export function resetImHandoffCycleForSession(sessionKey) {
    if (!sessionKey)
        return;
    const state = getHandoffCycleState(sessionKey);
    state.generation += 1;
    state.sentGeneration = null;
    state.expiresAt = Date.now() + HANDOFF_CYCLE_TTL_MS;
}
function hasSentHandoffInCurrentCycle(sessionKey) {
    if (!sessionKey)
        return false;
    const state = getHandoffCycleState(sessionKey);
    return state.sentGeneration === state.generation;
}
function markHandoffSentInCurrentCycle(sessionKey) {
    if (!sessionKey)
        return;
    const state = getHandoffCycleState(sessionKey);
    state.sentGeneration = state.generation;
    state.expiresAt = Date.now() + HANDOFF_CYCLE_TTL_MS;
}
function appendInputDiag(api, record) {
    try {
        const logPath = path.join(api.runtime.state.resolveStateDir(), ...LLM_INPUT_LOG_REL);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n", "utf8");
    }
    catch {
        /* diagnostic must never break the hook */
    }
}
function stringifyContent(c) {
    if (typeof c === "string")
        return c;
    if (Array.isArray(c)) {
        return c
            .map((p) => {
            if (typeof p === "string")
                return p;
            if (p?.type === "text" && typeof p.text === "string")
                return p.text;
            return JSON.stringify(p);
        })
            .join("\n");
    }
    return JSON.stringify(c ?? "");
}
function stripImHandoffMarkers(text) {
    return text
        .split("\n")
        .filter((line) => !/^\s*MEDIA:.*handoff\.jpg.*$/i.test(line))
        .filter((line) => !/^\s*<\s*(?:browser|computer)-handoff\s*\/?>\s*$/i.test(line))
        .map((line) => line.replace(/<\s*(?:browser|computer)-handoff\s*\/?>/gi, ""))
        .join("\n")
        .replace(/^\n+/, "");
}
function stripWebHandoffTags(text) {
    return text
        .split("\n")
        .filter((line) => !/^\s*<\s*(?:browser|computer)-handoff\s*\/?>\s*$/i.test(line))
        .map((line) => line.replace(/<\s*(?:browser|computer)-handoff\s*\/?>/gi, ""))
        .join("\n")
        .replace(/^\n+/, "");
}
function shouldTreatSourceAsHandoffReply(source, finalStr) {
    if (!source || finalStr.trim().length === 0)
        return false;
    // BUA source is only marked after the agent explicitly prepares the handoff
    // screenshot path (`bua screenshot` + handoff.jpg). That tool event is the
    // deterministic handoff intent; do not depend on the LLM remembering a MEDIA
    // marker in the final Chinese guidance.
    if (source === "bua")
        return true;
    // CUA paused/interrupted handoffs often surface as rewritten Chinese prose
    // without MEDIA because the CUA tool output is intentionally neutralized for
    // IM. Treat the next substantive Feishu/Lark reply as the CUA handoff.
    return source === "cua";
}
function stripImHandoffMarkersFromEvent(event, texts, finalStr, fallbackText) {
    if (!Array.isArray(event?.assistantTexts) || texts.length === 0)
        return finalStr;
    const sanitized = stripImHandoffMarkers(finalStr);
    const replacement = fallbackText ?? sanitized;
    if (sanitized === finalStr && replacement === finalStr)
        return sanitized;
    event.assistantTexts[texts.length - 1] = replacement;
    if (event?.lastAssistant && typeof event.lastAssistant.content === "string") {
        event.lastAssistant.content = fallbackText
            ? replacement
            : stripImHandoffMarkers(event.lastAssistant.content);
    }
    else if (event?.lastAssistant &&
        Array.isArray(event.lastAssistant.content)) {
        let wroteReplacement = false;
        const content = event.lastAssistant.content.map((part) => {
            if (part?.type === "text" && typeof part.text === "string") {
                if (fallbackText) {
                    if (!wroteReplacement) {
                        wroteReplacement = true;
                        return { ...part, text: replacement };
                    }
                    return { ...part, text: "" };
                }
                return { ...part, text: stripImHandoffMarkers(part.text) };
            }
            return part;
        });
        event.lastAssistant.content =
            fallbackText && !wroteReplacement
                ? [{ type: "text", text: replacement }, ...content]
                : content;
    }
    return sanitized;
}
function stripWebHandoffTagsFromEvent(event, texts, finalStr) {
    if (!Array.isArray(event?.assistantTexts) || texts.length === 0)
        return finalStr;
    const sanitized = stripWebHandoffTags(finalStr);
    if (sanitized === finalStr)
        return sanitized;
    event.assistantTexts[texts.length - 1] = sanitized;
    if (event?.lastAssistant && typeof event.lastAssistant.content === "string") {
        event.lastAssistant.content = stripWebHandoffTags(event.lastAssistant.content);
    }
    else if (event?.lastAssistant &&
        Array.isArray(event.lastAssistant.content)) {
        event.lastAssistant.content = event.lastAssistant.content.map((part) => {
            if (part?.type === "text" && typeof part.text === "string") {
                return { ...part, text: stripWebHandoffTags(part.text) };
            }
            return part;
        });
    }
    return sanitized;
}
export function createLlmOutputDiagHook(api) {
    return async (event, ctx) => {
        // PluginHookLlmOutputEvent: { ..., assistantTexts: string[], lastAssistant }
        const texts = Array.isArray(event?.assistantTexts)
            ? event.assistantTexts
            : [];
        const finalText = texts.length > 0 ? texts[texts.length - 1] : "";
        const finalStr = typeof finalText === "string" ? finalText : "";
        const hasMediaLine = /^MEDIA:/m.test(finalStr);
        const firstLine = finalStr.split("\n", 1)[0] ?? "";
        // 完整捕获所有含 MEDIA: 的整行(含前后字符) raw 字符串,用于诊断
        // openclaw outbound 为什么 reject。LLM 可能违反"第一行 hard rule",
        // 或者路径携带不可见字符 / 空格 / typo / 自创路径。完整 raw 行是
        // keystone 证据。限制 5 条防爆。
        const mediaLines = finalStr
            .split("\n")
            .filter((line) => /MEDIA:/i.test(line))
            .slice(0, 5);
        // CUA 时序修正 + 飞书发图触发条件:
        //
        // 触发条件统一为 `isHandoffReply`(LLM 第一行输 `MEDIA:...handoff.jpg`)。
        // 这条 marker 规则在 conversation-source.ts 里强制要求 LLM 在
        // wait_for_user 场景才输 MEDIA: 行,中间执行进度(检查清单 / 6 步
        // ✅ 行)不会输 MEDIA: → 不触发 re-prep / send,**不打断 lark plugin
        // streaming card** 的中间 prose 追加。
        //
        // 之前用 `final_text_length > 100` 当兜底,误命中中间 chunks → 提前
        // 发图打断 streaming card finalize,导致飞书用户只看到末段引导,
        // 检查清单 + 6 步进度被 lark streaming card "thinking" 状态压掉。
        //
        // 时机正确性:LLM 在 cua INTERRUPTED 时才会按 marker 输出 MEDIA: 行,
        // 此时桌面已是终态,re-prep 拿到 fresh 截图,飞书 sender 主动发图。
        const provider = typeof ctx?.messageProvider === "string" ? ctx.messageProvider : "";
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        // sessionKey 第三段 prefix 容错与 conversation-source.ts:77
        // extractImChannelFromSessionKey 的兜底哲学保持一致。openclaw 上游当前
        // (src/routing/session-key.ts:197-249) 只产 colon-separated 第三段
        // (agent:main:feishu:...:direct:ou_xxx 等 5 种),但 conversation-source.ts:21
        // 已留 "假设上游命名" 兜底注释,这里做对齐防御:若未来上游产
        // agent:main:feishu-<chat-id> 这种 dash 第三段,exec-event 回合不会把真飞书会话
        // 误判为非飞书 → recentHandoffSource / 发图链路不被错过。
        const isFeishu = provider === "feishu" || isFeishuChannelSessionKey(sessionKey);
        const isIm = isFeishu ||
            detectConversationSource({ messageProvider: provider, sessionKey }) ===
                "im";
        const hasHandoffTag = /<\s*(?:browser|computer)-handoff\s*\/?>/i.test(finalStr);
        // LLM 偶尔会把整段响应包在 markdown code block 里(```...```),
        // 导致 firstLine 是 "```" 而非 MEDIA: 行,strict 检测落空 +
        // recentHandoffSource 又因 after_tool_call 时序竞态可能未就绪,
        // 整个 isHandoffReply 链路被静默放过 → 用户看到 raw code block + MEDIA: 字面文本。
        // 兜底:多行任意位置匹配,容忍 LLM 把 MEDIA: 行写在第 2 行(```之后)
        // 或前面带空格 / quote marker。strip 已是 multiline,只补 detect。
        const hasMediaHandoffMarker = /^MEDIA:.*handoff\.jpg/i.test(firstLine) ||
            /^[\s>]*MEDIA:.*handoff\.jpg/im.test(finalStr);
        // 微信 handoff 主动发(对齐飞书):recentHandoffSource 覆盖全部 IM 渠道。
        // 对飞书无行为变化(isIm⊇isFeishu);对微信新增 exec-event(CUA)的
        // markHandoffSource("cua") / BUA tool 的 markHandoffSource("bua") 感知。
        const recentHandoffSource = isIm
            ? getRecentHandoffSource(sessionKey)
            : null;
        const hasRecentHandoffSource = shouldTreatSourceAsHandoffReply(recentHandoffSource, finalStr);
        // isFeishu → isIm:微信也凭 MEDIA marker / handoff tag 进入 handoff 判定
        // (微信 exec-event 回合 LLM 会输 MEDIA:handoff.jpg)。对飞书等价(isIm⊇isFeishu),
        // 对非 IM 等价(isIm=false 时仅看 hasRecentHandoffSource,后者本就 null)。
        const isHandoffReply = (isIm && (hasMediaHandoffMarker || hasHandoffTag)) ||
            hasRecentHandoffSource;
        const openId = isFeishu
            ? (parseFeishuOpenIdFromSessionKey(sessionKey) ??
                parseFeishuOpenIdFromSessionKey(typeof ctx?.channelId === "string" ? ctx.channelId : ""))
            : null;
        const sanitizedFinalStr = isHandoffReply
            ? stripImHandoffMarkers(finalStr)
            : finalStr;
        const isEmptyHandoffAfterStrip = isHandoffReply && sanitizedFinalStr.trim().length === 0;
        const fallbackText = isEmptyHandoffAfterStrip
            ? IM_HANDOFF_FALLBACK_TEXT
            : undefined;
        if (isHandoffReply && isIm && isFeishu) {
            // Best-effort text cleanup for IM: Web handoff tags are frontend-only and
            // MEDIA is only an intent marker now. Whether OpenClaw consumes mutated
            // llm_output events before dispatch is deployment-version dependent, so
            // keep prompt-side Chinese guidance as the primary contract and log raw
            // output above for verification.
            stripImHandoffMarkersFromEvent(event, texts, finalStr, fallbackText);
        }
        else if (isIm && !isFeishu && isHandoffReply) {
            // 微信 handoff:改为 plugin 主动 sendWechatHandoffViaOpenClaw 发图(唯一文件名),
            // 必须与飞书对称 strip 掉 LLM 的 MEDIA:handoff.jpg 行 + handoff tag,使
            // openclaw outbound 不再读固定 handoff.jpg → 彻底消除 ENOENT / off-by-one 竞态。
            stripImHandoffMarkersFromEvent(event, texts, finalStr, fallbackText);
        }
        else if (isIm && !isFeishu && hasHandoffTag) {
            // Non-handoff Non-Feishu IM: only remove accidental Web-only handoff tags
            // if the model emits them despite the IM prompt.
            stripWebHandoffTagsFromEvent(event, texts, finalStr);
        }
        let handoffPath = null;
        const shouldSkipDuplicateEmptyHandoff = isEmptyHandoffAfterStrip && hasSentHandoffInCurrentCycle(sessionKey);
        // Bug A 配套:防 LLM 听话回 HEARTBEAT_OK 时被 source mark 误触发发图。
        // exec-event 那一轮 user_prompt 要求 reply HEARTBEAT_OK only;LLM 听话时
        // 输出就只有 "HEARTBEAT_OK" 12 字符。此时即便 source=cua,plugin 也不应
        // 发图(因为 IM 用户看到"HEARTBEAT_OK + 图"不是预期内容)。门槛设 20
        // 字符,远低于真实引导 prose 长度(实测 ~236 字),不误伤。
        const HEARTBEAT_OK_MIN_PROSE_LEN = 20;
        const trimmedFinal = finalStr.trim();
        const isHeartbeatNoise = trimmedFinal === "HEARTBEAT_OK" ||
            trimmedFinal.length < HEARTBEAT_OK_MIN_PROSE_LEN;
        // 微信收件人 to = ctx.channelId(微信 DM sessionKey 退化为 agent:main:main 无
        // open id;resolveAgentHookChannelId 把 rawId / messageTo 解析成 weChat userId,
        // 与飞书 openId 兜底同源,obs 9788 已证)。
        //
        // DM-only 边界(coco MAJOR):openclaw-weixin 该实现是纯 DM —— process-message.ts
        // 全程硬编码 isGroup:false + peer:{kind:"direct"},无任何群路由(无 isGroup:true /
        // kind:"group"),故 channelId 恒为 DM 用户 id。防御性再排除明显群 id 格式
        // (personal-WeChat @chatroom),与飞书只发 ou_(DM)、跳 oc_(群) 的隐私边界对齐:
        // 登录页/二维码截图绝不外发到群。
        //
        // R3(coco C3 / agy MINOR)已知边界 —— 升级 openclaw-weixin 必 re-verify:
        //   ① "纯 DM" 依赖上游 process-message.ts 的 isGroup:false 硬编码(不在本仓,无法
        //      静态核验);若上游某版本开启群路由,本处需补正向 DM 白名单。
        //   ② @chatroom guard 只覆盖 **个人微信** 群 id 格式;**企业微信(WeCom)** 群 id
        //      可能是别的形态(如 wr* / UUID),不带 @chatroom → 本 guard 不命中。
        //      实测 DM userId 形如 `<id>@im.wechat`(非 wxid_),故 **不能** 用 wxid_/wm_
        //      正向白名单(会掐掉真实 DM)。接 WeCom 前必须重新设计群识别。
        const rawWechatTo = isIm && !isFeishu && typeof ctx?.channelId === "string"
            ? ctx.channelId
            : "";
        const wechatTo = rawWechatTo.includes("@chatroom") ? "" : rawWechatTo;
        const shouldCaptureFreshHandoffWechat = isHandoffReply &&
            isIm &&
            !isFeishu &&
            !shouldSkipDuplicateEmptyHandoff &&
            !isHeartbeatNoise &&
            wechatTo.length > 0;
        const shouldCaptureFreshHandoff = isHandoffReply &&
            isIm &&
            isFeishu &&
            !shouldSkipDuplicateEmptyHandoff &&
            !isHeartbeatNoise &&
            openId != null;
        if (shouldCaptureFreshHandoff || shouldCaptureFreshHandoffWechat) {
            try {
                handoffPath = captureFreshHandoffScreenshot();
            }
            catch {
                /* never break */
            }
            // IM handoff 改为 intent-driven: MEDIA:...handoff.jpg 或 Web handoff
            // tag 只表示「需要用户接管并配图」,不再读取 LLM/BUA/CUA 产出的固定
            // handoff.jpg。hook 在感知 intent 后立即自己截一张唯一文件名截图；
            // 失败则跳过发送,绝不 fallback 到旧 handoff.jpg,避免跨 session stale 图。
            // Feishu direct user 走低层 sender 主动发图；其它 IM channel 不在
            // 这里补图,继续走 LLM 原始 MEDIA directive → openclaw outbound 的
            // 标准发送路径,避免 Feishu workaround 污染微信等渠道。
        }
        // (已移除)微信固定文件原地覆盖 captureHandoffScreenshotInPlace:
        // Direction B 改为 plugin 主动 sendWechatHandoffViaOpenClaw 发图(唯一文件名)
        // + strip MEDIA,openclaw outbound 不再读固定 handoff.jpg → 固定文件竞态
        // (首次 ENOENT / 后续 off-by-one)的根因被结构性消除,此处不再写固定文件。
        // 飞书 channel workaround:openclaw-lark plugin 内部
        // reply-dispatcher.ts:351 调 sendMediaLark 漏传 mediaLocalRoots →
        // validateLocalMediaRoots 抛 "not configured" → fallback 📎 link 文本。
        // 直接调 lark plugin 已 export 的低层 primitive 自己发图。
        // 详见 feishu-handoff-sender.ts 头部注释。
        //
        // **stash + agent_end** 设计(不用 setTimeout 延迟):
        // llm_output fire 时 LLM 还在 streaming 后续 chunks,lark plugin
        // 的 streaming card controller 还在 finalize 中。如果此时直接调
        // sendImageLark 发独立 image,会被 controller 侦测到 → finalize
        // 当前 card → 后续 chunks(检查清单 / 6 步 ✅ 进度)被吃掉。
        // 这里仅 stash 状态,真正发图放 agent_end hook(LLM run 完整结束
        // 后,openclaw 已派发完所有 outbound,lark card 已 finalize 完整
        // prose) — 100% 不打断 card。
        if (isHandoffReply) {
            // trace 到 feishu-handoff-sender.log,定位飞书分支没触发的卡点
            try {
                const traceLog = path.join(api.runtime.state.resolveStateDir(), "extensions", "skill-switch", "feishu-handoff-sender.log");
                fs.mkdirSync(path.dirname(traceLog), { recursive: true });
                fs.appendFileSync(traceLog, JSON.stringify({
                    ts: new Date().toISOString(),
                    stage: "llm_output_handoff_detect",
                    isHandoffReply,
                    isFeishu,
                    recentHandoffSource,
                    provider,
                    sessionKey: sessionKey.slice(0, 80),
                    handoffPath,
                    handoff_exists: handoffPath ? fs.existsSync(handoffPath) : null,
                    channelId: typeof ctx?.channelId === "string" ? ctx.channelId : null,
                    openId,
                }) + "\n", "utf8");
            }
            catch {
                /* never break */
            }
        }
        // V0 飞书发图:plugin 主动调 openclaw P1 SDK(替代 V7 stash + 800ms timer)
        // 走 openclaw outbound pipeline → feishuOutbound.sendMedia(正确传 mediaLocalRoots,
        // 无 V7 Bug 2)→ 真发图。spike v1 实测 prose 不被 lark streaming card 打断。
        // 详见 design doc D1 / D6 / §6.1 outcome 表。
        if (isHandoffReply && isFeishu && handoffPath && openId) {
            // source 是 LLM 输入信号(标识"本轮输出为何被识别为 handoff"),与
            // delivery state 解耦 — 无论 sender 成功失败都同步 consume,避免 stale
            // source 被下一轮无关 prose 误判为 handoff(三方 review Fix C,Coco verify)。
            if (recentHandoffSource) {
                consumeRecentHandoffSource(sessionKey);
            }
            // Fix C(三方 review):mark 改到 sender outcome === "success" 时才
            // commit。原 V0 同步预 mark + fire-and-forget 在 sender 失败(error /
            // empty_results / skip_*)时已写 mark,同 cycle 下一轮空 prose MEDIA
            // 会被 shouldSkipDuplicateEmptyHandoff skip → 用户 cycle 内拿不到图。
            //
            // 安全性假设:llm_output 是 finalize-level hook(实测 ECS log 间隔 31s
            // 起,远 ≫ sender 几百毫秒 I/O)→ async mark 在下次 llm_output 触发前
            // 已 commit,不引入 race。**如未来 hook 模型变 chunk-level**(几百毫秒
            // 内多次触发),本异步 mark 会有 race window,需改回同步 mark + design
            // doc ACK no-retry,详见 design §12 M-Fix-C v2。
            //
            // .catch 防御 sender 未来若违反 "never throw" 契约,本 fire-and-forget
            // 仍然不抛 unhandled rejection。
            void sendFeishuHandoffViaOpenClaw({
                api,
                sessionKey,
                openId,
                handoffPath,
            })
                .then((result) => {
                if (result.outcome === "success") {
                    markHandoffSentInCurrentCycle(sessionKey);
                }
            })
                .catch(() => {
                /* sender 内 try/catch 全包,理论永不抛;此处仅防御性兜底 */
            });
        }
        // 微信 handoff source consume(coco MINOR):无论能否发图(wechatTo 为空被 DM guard
        // 拦下 / capture 失败 handoffPath=null),只要进入微信 handoff 判定就 consume source,
        // 避免 stale source 残留被下一轮无关 prose 误判为 handoff(与飞书 consume 语义对齐)。
        if (isHandoffReply && isIm && !isFeishu && recentHandoffSource) {
            consumeRecentHandoffSource(sessionKey);
        }
        // 微信 handoff:plugin 主动经 deliverOutboundPayloads(channel:"openclaw-weixin")
        // 发图(对齐飞书 P1 设计)。唯一文件名 fresh 截图 + 已 strip MEDIA → openclaw
        // outbound 不再读固定 handoff.jpg,彻底绕开 ENOENT / off-by-one 竞态。覆盖 BUA+CUA
        // (二者都经此 handoff intent 判定)。cycle mark 语义对齐飞书。
        if (isHandoffReply && isIm && !isFeishu && handoffPath && wechatTo) {
            void sendWechatHandoffViaOpenClaw({
                api,
                sessionKey,
                to: wechatTo,
                handoffPath,
            })
                .then((result) => {
                if (result.outcome === "success") {
                    markHandoffSentInCurrentCycle(sessionKey);
                }
            })
                .catch(() => {
                /* sender 内 try/catch 全包,理论永不抛;此处仅防御性兜底 */
            });
        }
        try {
            const logPath = path.join(api.runtime.state.resolveStateDir(), ...LLM_INPUT_LOG_REL.slice(0, -1), "im-llm-output.log");
            fs.mkdirSync(path.dirname(logPath), { recursive: true });
            fs.appendFileSync(logPath, JSON.stringify({
                ts: new Date().toISOString(),
                hook: "llm_output",
                model: event?.model ?? null,
                assistantText_count: texts.length,
                final_text_length: finalStr.length,
                has_media_line: hasMediaLine,
                media_lines: mediaLines,
                first_line: firstLine.slice(0, 200),
                final_text_first_400: finalStr.slice(0, SAMPLE_LEN),
                final_text_last_400: finalStr.slice(-SAMPLE_LEN),
            }) + "\n", "utf8");
        }
        catch {
            /* never break */
        }
    };
}
export function createLlmInputDiagHook(api) {
    return async (event, ctx) => {
        // PluginHookLlmInputEvent: { runId, sessionId, provider, model,
        //   systemPrompt?, prompt, historyMessages[], imagesCount, tools? }
        const systemPrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
        const userPrompt = typeof event?.prompt === "string" ? event.prompt : "";
        const history = Array.isArray(event?.historyMessages)
            ? event.historyMessages
            : [];
        const markerIdx = systemPrompt.indexOf(MARKER);
        const hasMarker = markerIdx >= 0;
        const markerExcerpt = hasMarker
            ? systemPrompt.slice(markerIdx, markerIdx + SAMPLE_LEN)
            : null;
        appendInputDiag(api, {
            hook: "llm_input",
            model: event?.model ?? null,
            provider: event?.provider ?? null,
            event_keys: event ? Object.keys(event) : [],
            system_total_length: systemPrompt.length,
            has_marker: hasMarker,
            marker_position: markerIdx,
            marker_excerpt: markerExcerpt,
            system_first_400: systemPrompt.slice(0, SAMPLE_LEN),
            system_last_400: systemPrompt.slice(-SAMPLE_LEN),
            user_prompt_length: userPrompt.length,
            user_prompt_first_400: userPrompt.slice(0, SAMPLE_LEN),
            history_count: history.length,
            history_last_roles: history.slice(-5).map((m) => m?.role ?? "?"),
            history_last_snippet: history.length
                ? stringifyContent(history[history.length - 1]?.content).slice(0, SAMPLE_LEN)
                : null,
            images_count: typeof event?.imagesCount === "number" ? event.imagesCount : null,
            ctx_keys: ctx ? Object.keys(ctx) : [],
        });
        try {
            const outcome = captureSessionModelFromLlmInput(api, event, ctx);
            if (outcome.kind === "captured") {
                api.logger.info?.(`[skill-switch] captured session model scope=web sessionId=${outcome.snapshot.sessionId} provider=${outcome.snapshot.provider} modelId=${outcome.snapshot.modelId} observedAt=${outcome.snapshot.observedAt}`);
            }
            else if (outcome.kind === "fallback") {
                api.logger.warn?.(`[skill-switch] fallback to default model reason=${outcome.reason} sessionId=${typeof ctx?.sessionKey === "string" ? ctx.sessionKey : ""}`);
            }
        }
        catch {
            /* never break */
        }
        // Bug A fix: openclaw 上游 heartbeat-runner 在 background CUA 任务完成时触发
        // 独立 LLM 回合(messageProvider="exec-event",user_prompt 含
        // `reply HEARTBEAT_OK only` 指令)。这条路径上 plugin 之前没有任何
        // markHandoffSource("cua") 入口(after_tool_call_cua 在 spawn ack 上
        // isCuaResultInterrupted=false 不命中;handleRunCommand INTERRUPTED
        // 只对同步 /cua run slash command 命中)。导致 LLM 即使违规吐 prose
        // 也因为 hasRecentHandoffSource=false 不发图。
        //
        // 这里在 exec-event 触发的 IM session 上无差别 mark source=cua,让既有的
        // llm_output hook 走 hasRecentHandoffSource → isHandoffReply → 抓 fresh + send 链路。
        const messageProvider = typeof ctx?.messageProvider === "string" ? ctx.messageProvider : "";
        const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "";
        if (messageProvider === EXEC_EVENT_PROVIDER && sessionKey) {
            const src = detectConversationSource({
                messageProvider,
                sessionKey,
            });
            if (src === "im") {
                // 先 consume 上一轮残留(可能是 bua,可能是上一个 cua 任务的 stale 状态),
                // 再重新 mark 为 cua,保证 source 反映"当前这次 exec-event 完成"的 intent。
                consumeRecentHandoffSource(sessionKey);
                markHandoffSource(sessionKey, "cua");
                // (已移除)HEAD a86078ee 在此 exec-event 分支同步抓固定 handoff.jpg
                // 的逻辑:Direction B 改为 llm_output 主动 sendWechatHandoffViaOpenClaw
                // 发图(唯一文件名)+ strip MEDIA。这里仅保留 markHandoffSource("cua")
                // 作为 source 信号 —— llm_output hook 凭 recentHandoffSource="cua"
                // (hasRecentHandoffSource → isHandoffReply)即可触发主动发图,不再赌
                // "plugin 写固定文件早于 outbound 读"的时序,跨 openclaw 版本稳定。
            }
        }
    };
}
//# sourceMappingURL=llm-input-diag-hook.js.map