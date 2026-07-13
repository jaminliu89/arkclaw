// VTP 二期 P4 可观测性 — plugin 侧 tracer 抽象 (ADR-0028 日志全迁 OneAgent)。
//
// withVtpSpan: L3 vtp.* handler-level span wrapper。外部 callers 签名不变，
//   内部从 no-op 升级为真实 OTel span。span 创建后通过 context.with 设为 active，
//   body() 执行期间内部任何 tracer.startSpan() 自动成为本 span 的子节点。
//   OTel 未初始化时降级为 NOOP_SPAN（API 层自动返回 NonRecordingSpan）。
//
// withCommandSpan: L2 command.* 通用 RPC/调度层织入封装。
//   - span 名 = name 参数 (如 "command.start")
//   - 自动记录 command.duration histogram + command.total counter
//   - body result/error sacred：任何 instrumentation 异常不得掩盖 body 结果
//   - D3: command span 是其内部所有业务子 span 的父级。通过 context.with(ctx, body)
//     把 command span 设为 active context，body 内 withVtpSpan 创建的 span 自动
//     成为子节点，整条 trace 共享同一 trace id。
import { context, trace, SpanStatusCode } from "@opentelemetry/api";
import { incrementCounter, recordHistogram } from "./metrics.js";
// 将 OTel Span 包装为 VtpSpan，隔离外部对 SpanStatusCode 的直接依赖。
function wrapOtelSpan(otelSpan) {
    return {
        setAttribute(key, value) {
            try {
                // OTel SpanAttributeValue 不接受 null/object，做基础安全转换
                if (value === null || value === undefined)
                    return;
                if (typeof value === "string" ||
                    typeof value === "number" ||
                    typeof value === "boolean") {
                    otelSpan.setAttribute(key, value);
                }
                else {
                    otelSpan.setAttribute(key, String(value));
                }
            }
            catch {
                // silent — instrumentation errors must not mask body results
            }
        },
        setStatus({ code, message }) {
            try {
                otelSpan.setStatus({
                    code: code === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
                    message,
                });
            }
            catch {
                // silent
            }
        },
        end() {
            try {
                otelSpan.end();
            }
            catch {
                // silent
            }
        },
    };
}
const NOOP_SPAN = {
    setAttribute() { },
    setStatus() { },
    end() { },
};
/**
 * 白名单校验 error_code metric label，防止基数爆炸。
 * 仅接受 /^[A-Z][A-Z0-9_]+$/ 且长度 ≤ 64 的值；其他一律返回 "UNKNOWN"。
 * 单字符 (如 "A") 也视为无效 — 合法 error code 至少两字符。
 */
export function sanitizeErrorCode(raw) {
    if (typeof raw === "string" &&
        /^[A-Z][A-Z0-9_]+$/.test(raw) &&
        raw.length <= 64) {
        return raw;
    }
    return "UNKNOWN";
}
/**
 * 包装一个异步函数到 OTel span（vtp tracer）。
 * 在 plugin handler 头部使用:
 *
 *   export async function handleSaveAsSkill(api, ctx) {
 *     return withVtpSpan("vtp.rpc.saveAsSkill",
 *       { recordingId: ctx.params.recordingId },
 *       async (span) => { ... });
 *   }
 *
 * 结构对齐 withCommandSpan：
 *   - startSpan 在独立 try/catch；失败 → vtpSpan=NOOP_SPAN, otelSpan=undefined
 *   - body 通过 runBody() 恰好执行一次（无 fallback 重跑）
 *   - finally 保证 vtpSpan.end()
 */
export async function withVtpSpan(spanName, attrs, body) {
    let vtpSpan = NOOP_SPAN;
    let otelSpan;
    // startSpan in its own try/catch — failure degrades to NOOP_SPAN; body
    // still runs exactly once below.
    try {
        const tracer = trace.getTracer("vtp");
        otelSpan = tracer.startSpan(spanName);
        vtpSpan = wrapOtelSpan(otelSpan);
        // Set initial attributes
        for (const [k, v] of Object.entries(attrs)) {
            vtpSpan.setAttribute(k, v);
        }
    }
    catch {
        // OTel API unavailable — use no-op span, body still runs
        vtpSpan = NOOP_SPAN;
        otelSpan = undefined;
    }
    // Bind otelSpan into active context so any tracer.startSpan() inside body()
    // becomes a child of this span. If otelSpan is undefined (OTel unavailable),
    // run body() directly with no context binding.
    const runBody = () => {
        if (otelSpan) {
            const ctx = trace.setSpan(context.active(), otelSpan);
            return context.with(ctx, () => body(vtpSpan));
        }
        return body(vtpSpan);
    };
    let bodyResult;
    let bodyError;
    let bodyThrew = false;
    try {
        bodyResult = await runBody();
    }
    catch (e) {
        bodyThrew = true;
        bodyError = e;
        try {
            vtpSpan.setStatus({
                code: "error",
                message: e instanceof Error ? e.message : String(e),
            });
        }
        catch {
            // silent
        }
    }
    finally {
        vtpSpan.end();
    }
    if (bodyThrew) {
        throw bodyError;
    }
    return bodyResult;
}
/**
 * L2 command.* 通用 RPC / 调度层织入封装。
 *
 * - span 名 = name (e.g. "command.start")
 * - 自动 setAttribute: command.name, command.trigger, + 所有 attrs
 * - 自动记录 command.duration Histogram + command.total Counter
 * - body result/error sacred：instrumentation 异常绝不掩盖 body 返回值或抛出
 *
 * @param name     span 名，形如 "command.start" / "command.cleanup"
 * @param trigger  调用来源: "rpc" | "scheduler" | "system"
 * @param attrs    额外属性，如 { run_id, "vtp.recording_id" }
 * @param body     实际业务逻辑，接收 VtpSpan 可手动追加属性
 */
export async function withCommandSpan(name, trigger, attrs, body) {
    // Strip leading "command." prefix for metric label (e.g. "command.start" → "start")
    const command = name.startsWith("command.")
        ? name.slice("command.".length)
        : name;
    const startMs = Date.now();
    let result = "success";
    let errorCode;
    let bodyResult;
    let bodyError;
    let bodyThrew = false;
    // Get a span — falls back to NonRecordingSpan (no-op) if OTel not initialized
    let vtpSpan = NOOP_SPAN;
    let otelSpan;
    try {
        const tracer = trace.getTracer("vtp");
        otelSpan = tracer.startSpan(name);
        vtpSpan = wrapOtelSpan(otelSpan);
    }
    catch {
        // OTel API unavailable — use no-op span, body still runs
        vtpSpan = NOOP_SPAN;
    }
    // Set standard attributes
    try {
        vtpSpan.setAttribute("command.name", command);
        vtpSpan.setAttribute("command.trigger", trigger);
        for (const [k, v] of Object.entries(attrs)) {
            vtpSpan.setAttribute(k, v);
        }
    }
    catch {
        // silent — attribute errors must not break body execution
    }
    // Bind otelSpan into active context so any tracer.startSpan() inside body()
    // (e.g. nested withVtpSpan calls in Phase 4-6) becomes a child of this
    // command span on the same trace. If otelSpan is undefined (OTel API
    // unavailable), run body() directly with no context binding.
    const runBody = () => {
        if (otelSpan) {
            const ctx = trace.setSpan(context.active(), otelSpan);
            return context.with(ctx, () => body(vtpSpan));
        }
        return body(vtpSpan);
    };
    try {
        bodyResult = await runBody();
        result = "success";
    }
    catch (e) {
        bodyThrew = true;
        bodyError = e;
        result = "error";
        // Sanitize error_code — whitelist /^[A-Z][A-Z0-9_]+$/ ≤64 chars to
        // prevent metric label cardinality explosion from Node errno strings.
        const rawCode = e !== null && typeof e === "object" && "code" in e
            ? e.code
            : undefined;
        errorCode = sanitizeErrorCode(rawCode);
    }
    finally {
        const durationMs = Date.now() - startMs;
        // Set outcome attributes on span
        try {
            vtpSpan.setAttribute("command.success", result === "success");
            vtpSpan.setAttribute("command.duration_ms", durationMs);
            if (errorCode !== undefined) {
                vtpSpan.setAttribute("command.error_code", errorCode);
                vtpSpan.setStatus({ code: "error", message: errorCode });
            }
            else {
                vtpSpan.setStatus({ code: "ok" });
            }
        }
        catch {
            // silent
        }
        // gemini review: end() 独立 try —— 上面 setAttribute/setStatus 即便
        // 抛错(OTel 实际几乎不抛,但理论可能),也绝不能跳过 span.end(),
        // 否则 span 不入队导出、泄漏。
        try {
            vtpSpan.end();
        }
        catch {
            // silent
        }
        // Record metrics — both must be defensive
        try {
            const histAttrs = { command, trigger, result };
            recordHistogram("command.duration", durationMs, histAttrs);
        }
        catch {
            // silent
        }
        try {
            const ctrAttrs = {
                command,
                trigger,
                result,
                ...(errorCode !== undefined ? { error_code: errorCode } : {}),
            };
            incrementCounter("command.total", ctrAttrs);
        }
        catch {
            // silent
        }
    }
    if (bodyThrew) {
        throw bodyError;
    }
    return bodyResult;
}
//# sourceMappingURL=tracer.js.map