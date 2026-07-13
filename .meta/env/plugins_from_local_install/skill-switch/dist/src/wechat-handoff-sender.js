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
import fs from "node:fs";
import path from "node:path";
import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
const LOG_REL = ["extensions", "skill-switch", "wechat-handoff-sender.log"];
/** weixin channel canonical id（plugin id；deliverOutboundPayloads 按此解析 handler）。 */
const WECHAT_CHANNEL = "openclaw-weixin";
function appendLog(api, record) {
    try {
        const logPath = path.join(api.runtime.state.resolveStateDir(), ...LOG_REL);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, "utf8");
    }
    catch {
        /* never break */
    }
}
/**
 * Cleanup helper:删除已交付 / 已尝试的 handoff 截图,防止 disk leak。
 *
 * fresh-capture(`captureFreshHandoffScreenshot`)每次用 unique 路径
 * `handoff-fresh-<ts>-<rand>.jpg`,sender 是 terminal consumer → outcome 写完就清。
 * `force:true` 让 ENOENT(skip_handoff_missing 路径文件本就不存在)静默 no-op。
 *
 * R5(agy MAJOR#2):本 cleanup 在 sendWechatHandoffViaOpenClaw 的 finally 块无条件执行
 * (含 outcome="error"),是 **terminal、设计上不可重试** 的语义 —— sender 是一次性 terminal
 * consumer,任何 error/empty_results 都不在本函数内重试。若将来要加发送重试,**不能** 复用
 * 同一截图(已被删),必须重新 captureFreshHandoffScreenshot 拿新 unique 文件。
 */
function cleanupHandoffFile(handoffPath) {
    if (!handoffPath)
        return;
    try {
        fs.rmSync(handoffPath, { force: true });
    }
    catch {
        /* never break */
    }
}
export async function sendWechatHandoffViaOpenClaw(params) {
    try {
        return await computeOutcome(params);
    }
    catch (err) {
        // 顶层兜底:严格保证「永不抛错 / fire-and-forget 安全」契约,
        // 不依赖 computeOutcome 内部 catch 完备性。
        const error_message = err instanceof Error ? err.message : String(err);
        try {
            appendLog(params.api, {
                outcome: "error",
                error_layer: "top_level_guard",
                error_message,
                sessionKey: params.sessionKey,
                to: params.to,
                handoffPath: params.handoffPath,
            });
        }
        catch {
            /* never break */
        }
        return { outcome: "error", error_message };
    }
    finally {
        // 每个 outcome 完成后无条件清盘,防 disk leak。skip_invalid_input 时
        // handoffPath="" → cleanup no-op;skip_handoff_missing 时文件本就不存在
        // → rmSync force:true 静默 no-op。
        cleanupHandoffFile(params.handoffPath);
    }
}
async function computeOutcome(params) {
    // guard:to / handoffPath 必填
    if (!params.to || !params.handoffPath) {
        const outcome = { outcome: "skip_invalid_input" };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            to: params.to,
            handoffPath: params.handoffPath,
        });
        return outcome;
    }
    // guard:handoff 文件必须存在
    let exists = false;
    try {
        exists = fs.existsSync(params.handoffPath);
    }
    catch {
        /* keep false */
    }
    if (!exists) {
        const outcome = {
            outcome: "skip_handoff_missing",
        };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            handoffPath: params.handoffPath,
        });
        return outcome;
    }
    // try/catch 全包 → fire-and-forget caller 永不收到 unhandled rejection
    try {
        const results = await deliverOutboundPayloads({
            cfg: params.api.config,
            channel: WECHAT_CHANNEL,
            to: params.to,
            payloads: [{ mediaUrls: [params.handoffPath] }],
            bestEffort: true,
            ...(params.accountId ? { accountId: params.accountId } : {}),
        });
        if (!Array.isArray(results) || results.length === 0) {
            const outcome = { outcome: "empty_results" };
            appendLog(params.api, {
                ...outcome,
                sessionKey: params.sessionKey,
                to: params.to,
                handoffPath: params.handoffPath,
            });
            return outcome;
        }
        const message_ids = results
            .map((r) => String(r.messageId ?? ""))
            .filter(Boolean);
        // R1(coco C4):退化 messageId 防御 —— deliverOutboundPayloads 返回
        // [{messageId:""}] 时 results.length>0 但 message_ids 为空。此时不能判 success,
        // 否则 caller 误调 markHandoffSentInCurrentCycle → 同 cycle 后续重试被
        // shouldSkipDuplicateEmptyHandoff 拦截 → 用户拿不到图。返回 empty_results 让
        // caller 不 mark sent。
        // 注意(coco round-2 N1):本轮截图已被外层 finally `cleanupHandoffFile` 删除,
        // "重试"指**下一轮**触发 shouldCaptureFreshHandoffWechat 时**重新截图**(新 unique
        // 文件),不是复用本文件(本文件已不可用)。与 R5 JSDoc 的 terminal/不可重试语义一致。
        if (message_ids.length === 0) {
            const outcome = { outcome: "empty_results" };
            appendLog(params.api, {
                ...outcome,
                note: "degenerate_empty_message_id",
                sessionKey: params.sessionKey,
                to: params.to,
                handoffPath: params.handoffPath,
            });
            return outcome;
        }
        const outcome = {
            outcome: "success",
            message_ids,
        };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            to: params.to,
            handoffPath: params.handoffPath,
        });
        return outcome;
    }
    catch (err) {
        const error_message = err instanceof Error ? err.message : String(err);
        const outcome = {
            outcome: "error",
            error_message,
        };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            to: params.to,
            handoffPath: params.handoffPath,
            error_stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
        });
        return outcome;
    }
}
//# sourceMappingURL=wechat-handoff-sender.js.map