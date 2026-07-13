// gateway-handlers/observability.ts
//
// withRpcCommandSpan: RPC outcome-aware command span wrapper。
//
// 与 withCommandSpan (tracer.ts L2 通用封装) 的核心差异:
//   withCommandSpan 从 thrown error 感知成败。
//   RPC handler 不 throw — 走 ctx.respond(false, ...) 返回业务错误。
//   withRpcCommandSpan 拦截 ctx.respond,捕获第一次调用的 ok boolean + error.code,
//   再用该信息驱动正确的 command.* metric label (result=success|error)。
//
// 指标链路:
//   withVtpSpan  → OTel span (自动父子节点 / context 传播)
//   recordHistogram("command.duration") → 含 result 标签
//   incrementCounter("command.total")   → 含 result 标签(可选 error_code)
//   vtpLog.info rpc_call 审计行
//
// ADR-0028 + VTP 二期 P4 Task 3.0
import { withVtpSpan, sanitizeErrorCode } from "../observability/tracer.js";
import { incrementCounter, recordHistogram } from "../observability/metrics.js";
import { vtpLog } from "../observability/logger.js";
export async function withRpcCommandSpan(ctx, rpcName, attrs, body) {
    // ── Step 1: intercept ctx.respond to capture the first ok/error ─────────
    let capturedOk;
    let capturedErrorCode;
    // H9: Object.create 保留 ctx 的原型链 —— host 未来给 GatewayContext 加
    // 方法 / getter 时不会丢失。{...ctx} 浅拷贝只复制 own enumerable 属性,
    // 跨 openclaw 版本脆弱。只在实例层覆盖 respond。
    const wrappedCtx = Object.create(ctx);
    wrappedCtx.respond = (ok, data, error) => {
        // Only capture the first respond call (handlers respond once)
        if (capturedOk === undefined) {
            capturedOk = ok;
            if (!ok && error?.code) {
                capturedErrorCode = sanitizeErrorCode(error.code);
            }
        }
        ctx.respond(ok, data, error);
    };
    // ── Step 2: timing + span via withVtpSpan ───────────────────────────────
    const startMs = Date.now();
    // Propagate standard command attrs into the span
    const spanAttrs = {
        "command.name": rpcName,
        "command.trigger": "rpc",
        ...attrs,
    };
    let bodyThrewError;
    let bodyThrew = false;
    try {
        await withVtpSpan("command." + rpcName, spanAttrs, async (span) => {
            // Run the handler body
            try {
                await body(wrappedCtx, span);
            }
            catch (e) {
                bodyThrew = true;
                bodyThrewError = e;
                // Let finally record metrics before re-throwing below
            }
            // Default ok to true if body completed without calling respond
            // (defensive; shouldn't happen in practice)
            const ok = capturedOk ?? true;
            // bodyThrew overrides ok — an exception is always an error regardless
            // of whether respond was called first.
            const result = bodyThrew || !ok ? "error" : "success";
            const errCode = capturedErrorCode ??
                (bodyThrew
                    ? sanitizeErrorCode(bodyThrewError !== null &&
                        typeof bodyThrewError === "object" &&
                        "code" in bodyThrewError
                        ? bodyThrewError.code
                        : "INTERNAL_ERROR")
                    : undefined);
            // ── Step 3: set span outcome attrs ───────────────────────────
            try {
                span.setAttribute("command.success", ok && !bodyThrew);
                if (!ok || bodyThrew) {
                    span.setAttribute("command.error_code", errCode ?? "UNKNOWN");
                    span.setStatus({ code: "error" });
                }
            }
            catch {
                // silent — instrumentation must not mask body result
            }
            // ── Step 4: record metrics ────────────────────────────────────
            const durationMs = Date.now() - startMs;
            try {
                recordHistogram("command.duration", durationMs, {
                    command: rpcName,
                    trigger: "rpc",
                    result,
                });
            }
            catch {
                // silent
            }
            try {
                incrementCounter("command.total", {
                    command: rpcName,
                    trigger: "rpc",
                    result,
                    ...(result === "error" && errCode ? { error_code: errCode } : {}),
                });
            }
            catch {
                // silent
            }
            // ── Step 5: rpc_call audit log ────────────────────────────────
            try {
                const rid = typeof attrs["run_id"] === "string" ? attrs["run_id"] : undefined;
                vtpLog.info({ rid }, {
                    event: "rpc_call",
                    rpc: rpcName,
                    outcome: result,
                    durationMs,
                    ...(errCode ? { errorCode: errCode } : {}),
                });
            }
            catch {
                // silent — logging must never break the RPC
            }
            // Re-throw body errors AFTER metrics + audit log are done
            if (bodyThrew) {
                throw bodyThrewError;
            }
        });
    }
    catch (e) {
        // withVtpSpan re-throws body errors (body runs exactly once). Re-throw so
        // the gateway sees it. Instrumentation errors inside withVtpSpan are
        // swallowed there; only body errors propagate here.
        throw e;
    }
}
//# sourceMappingURL=observability.js.map