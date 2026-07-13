export interface VtpSpan {
    setAttribute(key: string, value: unknown): void;
    setStatus(status: {
        code: "ok" | "error";
        message?: string;
    }): void;
    end(): void;
}
/**
 * 白名单校验 error_code metric label，防止基数爆炸。
 * 仅接受 /^[A-Z][A-Z0-9_]+$/ 且长度 ≤ 64 的值；其他一律返回 "UNKNOWN"。
 * 单字符 (如 "A") 也视为无效 — 合法 error code 至少两字符。
 */
export declare function sanitizeErrorCode(raw: unknown): string;
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
export declare function withVtpSpan<T>(spanName: string, attrs: Record<string, unknown>, body: (span: VtpSpan) => Promise<T>): Promise<T>;
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
export declare function withCommandSpan<T>(name: string, trigger: "rpc" | "scheduler" | "system", attrs: Record<string, unknown>, body: (span: VtpSpan) => Promise<T>): Promise<T>;
//# sourceMappingURL=tracer.d.ts.map