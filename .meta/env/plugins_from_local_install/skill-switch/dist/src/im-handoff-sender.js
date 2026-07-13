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
import fs from "node:fs";
import path from "node:path";
import { deliverOutboundPayloads } from "openclaw/plugin-sdk/outbound-runtime";
const LOG_REL = ["extensions", "skill-switch", "feishu-handoff-sender.log"];
/** 飞书 user open_id 命名约定:固定 `ou_` 前缀 + 字母数字/下划线/连字符(实测) */
const FEISHU_OPEN_ID_RE = /\bou_[a-zA-Z0-9_-]+\b/;
/**
 * 从 sessionKey 抽取飞书 user open_id(DM only)。
 *
 * 实测格式:`agent:main:feishu:default:direct:ou_<32 hex>`。
 * 取首个 `ou_` token,group/chat (`oc_*`) 不匹配(返回 null 让 caller 跳过 — V0 仅
 * 覆盖 DM 场景)。
 */
export function parseFeishuOpenIdFromSessionKey(sessionKey) {
    if (!sessionKey)
        return null;
    const m = sessionKey.match(FEISHU_OPEN_ID_RE);
    return m ? m[0] : null;
}
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
 * V0 fresh-capture(`captureFreshHandoffScreenshot`,`cua_commands.ts:339`)每次
 * 用 unique 路径 `handoff-fresh-${Date.now()}-${rand}.jpg`,sender 是 terminal
 * consumer(caller 不会 / 不应重发同一文件)→ outcome 写完就清。`force:true`
 * 让 ENOENT(skip_handoff_missing 路径文件本就不存在)静默 no-op。整体 try/catch
 * 兜底防 EACCES 等 IO 异常打断 sender 的"永不抛错"契约(M4)。
 *
 * 已知 caveat:fire-and-forget caller(`void sendFeishuHandoffViaOpenClaw(...)`)
 * 模式下,如进程在 await 中被 SIGTERM/OOM 强杀,finally 块不执行,该次截图
 * 残留。这是 fire-and-forget 调用模式的固有约束,不是 cleanup 逻辑缺陷;V1
 * 排期加 boot-time 陈旧文件清扫脚本兜底。
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
export async function sendFeishuHandoffViaOpenClaw(params) {
    try {
        return await computeOutcome(params);
    }
    catch (err) {
        // 顶层兜底:严格保证文件头声明的"永不抛错 / fire-and-forget 安全"契约,
        // 不依赖 computeOutcome 内部 catch 完备性。当前 computeOutcome 已全包
        // try/catch,这里 future-proof 防御 — 未来 computeOutcome 新增前置逻辑
        // 漏 catch / params 结构异常 / appendLog 边缘抛错时,fire-and-forget caller
        // 仍然不会收到 unhandled rejection。
        const error_message = err instanceof Error ? err.message : String(err);
        try {
            appendLog(params.api, {
                outcome: "error",
                error_layer: "top_level_guard",
                error_message,
                sessionKey: params.sessionKey,
                openId: params.openId,
                handoffPath: params.handoffPath,
            });
        }
        catch {
            /* never break */
        }
        return { outcome: "error", error_message };
    }
    finally {
        // V7 deleteAfterSend 等价语义:每个 outcome 完成后无条件清盘,防 disk leak。
        // skip_invalid_input 时 handoffPath="" → cleanup no-op;skip_handoff_missing
        // 时文件本就不存在 → rmSync force:true 静默 no-op。
        cleanupHandoffFile(params.handoffPath);
    }
}
async function computeOutcome(params) {
    // M7 guard:openId / handoffPath 必填
    if (!params.openId || !params.handoffPath) {
        const outcome = {
            outcome: "skip_invalid_input",
        };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            openId: params.openId,
            handoffPath: params.handoffPath,
        });
        return outcome;
    }
    // M7 guard:handoff 文件必须存在
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
    // M4 try/catch 全包 → fire-and-forget caller 永不收到 unhandled rejection
    try {
        const results = await deliverOutboundPayloads({
            cfg: params.api.config,
            channel: "feishu",
            to: params.openId,
            payloads: [{ mediaUrls: [params.handoffPath] }],
            bestEffort: true,
            ...(params.accountId ? { accountId: params.accountId } : {}),
        });
        if (!Array.isArray(results) || results.length === 0) {
            const outcome = { outcome: "empty_results" };
            appendLog(params.api, {
                ...outcome,
                sessionKey: params.sessionKey,
                openId: params.openId,
                handoffPath: params.handoffPath,
            });
            return outcome;
        }
        const message_ids = results
            .map((r) => String(r.messageId ?? ""))
            .filter(Boolean);
        const outcome = {
            outcome: "success",
            message_ids,
        };
        appendLog(params.api, {
            ...outcome,
            sessionKey: params.sessionKey,
            openId: params.openId,
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
            openId: params.openId,
            handoffPath: params.handoffPath,
            error_stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
        });
        return outcome;
    }
}
//# sourceMappingURL=im-handoff-sender.js.map