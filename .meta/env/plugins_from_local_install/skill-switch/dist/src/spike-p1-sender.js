/**
 * SPIKE P1 — verify openclaw 官方 plugin SDK `deliverOutboundPayloads`
 * 主动发图能力(V3/V4 ECS 实测验证用,完全 isolated,不影响 V7 行为)。
 *
 * 触发条件(三选一,只要 enable 就触发,不去重):
 *   1. env var `SKILL_SWITCH_SPIKE_P1=1`
 *   2. marker 文件 `~/.openclaw/.enable-spike-p1` 存在
 *   3. 都没启用 → 整个 spike 入口 no-op,V7 行为完全不变
 *
 * 调用方式:`createAfterToolCallHook` 在 V7 现有 after_tool_call 逻辑之前
 * 插入 spike 入口分支,检测 `bua` / `cua` 工具调用 + IM 渠道 → 异步调
 * `runSpikeP1Send`(不 await,不阻塞 hook),触发后:
 *   - dump `sessionKey / messageProvider / agentId / parsed channel/to` 到
 *     `<stateDir>/extensions/skill-switch/spike-p1.log`
 *   - 调 `deliverOutboundPayloads({channel, to, payloads:[{mediaUrls:[handoffPath]}]})`
 *   - dump returned `OutboundDeliveryResult[]` 或 catch 的错误到同 log
 *
 * Spike 跟 V7 共存(双发图预期):V7 用 cross-plugin require 发飞书,
 * spike 同时调 P1 也发一张图。User 在飞书/微信端会**收到 2 张图**,
 * 这是预期的实验结果,用于 verify P1 路径真能到达 channel。
 *
 * Log 文件:`<stateDir>/extensions/skill-switch/spike-p1.log`
 *   - 每行 1 个 JSON event
 *   - stage 字段:`trigger / calling_deliverOutboundPayloads / result / error / skip`
 *
 * 设计约束:
 *   - 永不抛错(catch all),即使 spike 失败也不破坏 V7 production 路径
 *   - 不去重,user 自己控制触发频率(跑 1 次 bua / cua 触发 1 次)
 *   - 使用 V7 现有 `handoff.jpg`(如果存在)— 不自己抓图,纯 verify 发送能力
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
const SPIKE_LOG_REL = ["extensions", "skill-switch", "spike-p1.log"];
const SPIKE_FLAG_FILE = path.join(process.env.HOME || os.homedir(), ".openclaw", ".enable-spike-p1");
/** spike trigger 总开关:env var 或 marker 文件任一启用即可 */
export function isSpikeEnabled() {
    if (process.env.SKILL_SWITCH_SPIKE_P1 === "1")
        return true;
    try {
        return fs.existsSync(SPIKE_FLAG_FILE);
    }
    catch {
        return false;
    }
}
function appendSpikeLog(api, record) {
    try {
        const logPath = path.join(api.runtime.state.resolveStateDir(), ...SPIKE_LOG_REL);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
    }
    catch {
        /* never break */
    }
}
/**
 * 解析 channel 字符串 + to(target identifier)。
 *
 * 飞书 sessionKey 实测格式:`agent:main:feishu:default:direct:ou_<hex>`
 *   - channel = "feishu"
 *   - to = `ou_<hex>`(direct user)或 `oc_<hex>`(chat / group)
 *
 * 微信 sessionKey 推测格式(待 V3 verify):
 *   - 可能是 `agent:main:openclaw-weixin-<userId>@im.wechat`
 *   - 或 `agent:main:openclaw-weixin:default:direct:<userId>@im.wechat`
 *   - channel 推测 "openclaw-weixin"(对齐 plugin id),需 verify
 *   - to 是 `<userId>@im.wechat`(从 sessionKey 末段抽)
 *
 * 不能解析时返 channel/to = null,sender 跳过实际调用但仍写 log dump
 * 完整 sessionKey,供 user 看实际格式后修正。
 */
function parseChannelAndTo(sessionKey) {
    const parts = sessionKey.split(":");
    const rawSegments = parts.slice();
    const rawThird = parts[2] ?? null;
    let channel = null;
    let to = null;
    const third = rawThird?.toLowerCase() ?? "";
    if (third.startsWith("feishu") || third.startsWith("lark")) {
        channel = "feishu";
        const m = sessionKey.match(/\bou_[a-zA-Z0-9_-]+\b|\boc_[a-zA-Z0-9_-]+\b/);
        to = m ? m[0] : null;
    }
    else if (third.startsWith("openclaw-weixin") ||
        third.startsWith("wechat") ||
        third.startsWith("weixin")) {
        channel = "openclaw-weixin";
        const m = sessionKey.match(/[\w.-]+@im\.wechat/);
        to = m ? m[0] : null;
    }
    return { channel, to, rawThird, rawSegments };
}
export async function runSpikeP1Send(params) {
    const { api, sessionKey, messageProvider, agentId, channelId, triggerReason, } = params;
    if (!sessionKey) {
        appendSpikeLog(api, {
            stage: "skip",
            reason: "no_sessionKey",
            triggerReason,
        });
        return;
    }
    const parsed = parseChannelAndTo(sessionKey);
    appendSpikeLog(api, {
        stage: "trigger",
        sessionKey,
        messageProvider,
        agentId,
        channelId,
        parsed_channel: parsed.channel,
        parsed_to: parsed.to,
        parsed_rawThird: parsed.rawThird,
        parsed_segments_count: parsed.rawSegments.length,
        triggerReason,
    });
    if (!parsed.channel || !parsed.to) {
        appendSpikeLog(api, {
            stage: "skip",
            reason: "channel_or_to_unparsed",
            parsed,
        });
        return;
    }
    const handoffPath = path.join(process.env.HOME || os.homedir(), ".openclaw", "media", "outbound", "handoff.jpg");
    if (!fs.existsSync(handoffPath)) {
        appendSpikeLog(api, {
            stage: "skip",
            reason: "handoff_jpg_not_exists",
            handoffPath,
        });
        return;
    }
    let handoffStat = null;
    try {
        handoffStat = fs.statSync(handoffPath);
    }
    catch {
        /* keep null */
    }
    appendSpikeLog(api, {
        stage: "calling_deliverOutboundPayloads",
        channel: parsed.channel,
        to: parsed.to,
        handoffPath,
        handoff_size_bytes: handoffStat?.size ?? null,
        handoff_mtime_ms: handoffStat?.mtimeMs ?? null,
    });
    // 变体 A:`{mediaUrls:[path]}` 无 text + bestEffort:false + onError dump
    // (v3 关键:让 deliverOutboundPayloads 把内部 send 错误抛上来,不再 silent
    // swallow → spike log 能看到实际 fail 原因)
    const perPayloadErrors = [];
    try {
        const results = await deliverOutboundPayloads({
            cfg: api.config,
            channel: parsed.channel,
            to: parsed.to,
            payloads: [{ mediaUrls: [handoffPath] }],
            bestEffort: false,
            onError: (err, _payload) => {
                const msg = err instanceof Error ? err.message : String(err);
                const stk = err instanceof Error ? err.stack?.slice(0, 1500) : undefined;
                perPayloadErrors.push({
                    index: perPayloadErrors.length,
                    message: msg,
                    stack: stk,
                });
            },
        });
        appendSpikeLog(api, {
            stage: "result_variant_A_mediaUrls_only",
            results_count: Array.isArray(results) ? results.length : 0,
            results,
            perPayloadErrors,
        });
    }
    catch (err) {
        appendSpikeLog(api, {
            stage: "error_variant_A",
            error_message: err instanceof Error ? err.message : String(err),
            error_stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
            perPayloadErrors,
        });
    }
    // 变体 B:加 text 字段 + 同样 strict mode
    const perPayloadErrorsB = [];
    try {
        const results = await deliverOutboundPayloads({
            cfg: api.config,
            channel: parsed.channel,
            to: parsed.to,
            payloads: [{ text: "[SPIKE-P1 variant B]", mediaUrls: [handoffPath] }],
            bestEffort: false,
            onError: (err) => {
                const msg = err instanceof Error ? err.message : String(err);
                const stk = err instanceof Error ? err.stack?.slice(0, 1500) : undefined;
                perPayloadErrorsB.push({
                    index: perPayloadErrorsB.length,
                    message: msg,
                    stack: stk,
                });
            },
        });
        appendSpikeLog(api, {
            stage: "result_variant_B_text_plus_mediaUrls",
            results_count: Array.isArray(results) ? results.length : 0,
            results,
            perPayloadErrors: perPayloadErrorsB,
        });
    }
    catch (err) {
        appendSpikeLog(api, {
            stage: "error_variant_B",
            error_message: err instanceof Error ? err.message : String(err),
            error_stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
            perPayloadErrors: perPayloadErrorsB,
        });
    }
    // P2 fallback 探测 — weixin / lark 都做,对比 cross-plugin require 结构差异。
    // V7 飞书 cross-plugin require 已 work(feishu-handoff-sender.ts:150-173 上线),
    // 但 spike v2 测微信 weixin module 只暴露 "default" → 看 lark 是否也只 default,
    // 还是 lark 真的暴露了 uploadImageLark / sendImageLark 命名 export。
    for (const pluginId of ["openclaw-weixin", "openclaw-lark"]) {
        try {
            const stateDir = api.runtime.state.resolveStateDir();
            const pluginRoot = path.join(stateDir, "extensions", pluginId);
            const candidates = [
                path.join(pluginRoot, "index.js"),
                path.join(pluginRoot, "dist", "index.js"),
                pluginRoot,
            ];
            let mod = null;
            let loadedFrom = null;
            for (const p of candidates) {
                try {
                    if (p === pluginRoot || fs.existsSync(p)) {
                        mod = require(p);
                        loadedFrom = p;
                        break;
                    }
                }
                catch {
                    /* try next */
                }
            }
            const defaultExport = mod?.default;
            appendSpikeLog(api, {
                stage: `p2_${pluginId.replace("-", "_")}_require_attempt`,
                loadedFrom,
                top_level_keys: mod ? Object.keys(mod).slice(0, 50) : null,
                has_default: typeof defaultExport,
                default_keys: defaultExport && typeof defaultExport === "object"
                    ? Object.keys(defaultExport).slice(0, 50)
                    : null,
                // weixin 期望:sendWeixinMediaFile / resolveWeixinAccount / getContextToken
                weixin_has_sendWeixinMediaFile: typeof mod?.sendWeixinMediaFile,
                weixin_default_has_sendWeixinMediaFile: typeof defaultExport?.sendWeixinMediaFile,
                weixin_has_resolveWeixinAccount: typeof mod?.resolveWeixinAccount,
                weixin_default_has_resolveWeixinAccount: typeof defaultExport?.resolveWeixinAccount,
                weixin_has_getContextToken: typeof mod?.getContextToken,
                weixin_default_has_getContextToken: typeof defaultExport?.getContextToken,
                // lark 期望:uploadImageLark / sendImageLark / sendMediaLark
                lark_has_uploadImageLark: typeof mod?.uploadImageLark,
                lark_default_has_uploadImageLark: typeof defaultExport?.uploadImageLark,
                lark_has_sendImageLark: typeof mod?.sendImageLark,
                lark_default_has_sendImageLark: typeof defaultExport?.sendImageLark,
            });
        }
        catch (err) {
            appendSpikeLog(api, {
                stage: `p2_${pluginId.replace("-", "_")}_require_error`,
                error_message: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
//# sourceMappingURL=spike-p1-sender.js.map