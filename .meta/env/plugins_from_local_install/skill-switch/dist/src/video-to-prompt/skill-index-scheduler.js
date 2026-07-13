// 二期 D-20 双域解耦：任务模板域独立的 AUTO-INDEX rebuild 调度器。
// 从 cleanup-scheduler 剥离 rebuildCuaRecordingIndex（违反双域解耦：cleanup
// 隶属录制域 mp4/runs 生命周期，AUTO-INDEX 渲染隶属任务模板域）。
//
// 行为：
//   - startup hook：立即跑一次 rebuildFn（fire-and-forget catch）
//   - intervalHours > 0：setInterval(rebuildFn, intervalHours*3600_000)；timer.unref()
//   - intervalHours <= 0：关闭周期任务，仅跑 startup 一次
//
// 仿照 cleanup-scheduler 的模式（无 dependence 互相 import）。
import { withCommandSpan } from "./observability/tracer.js";
import { recordHistogram } from "./observability/metrics.js";
import { vtpLog } from "./observability/logger.js";
const MS_PER_HOUR = 3_600_000;
export function startSkillIndexScheduler(ctx) {
    const runOnce = () => {
        const tickStart = Date.now();
        void withCommandSpan("command.skillIndex", "scheduler", {}, async () => {
            const result = await ctx.rebuildFn();
            const durationMs = Date.now() - tickStart;
            try {
                recordHistogram("vtp.skill_index.entry_count", result.slugCount, {});
            }
            catch {
                // silent — metrics must not break tick
            }
            vtpLog.info(undefined, {
                event: "scheduler_tick",
                scheduler: "skillIndex",
                result: "success",
                durationMs,
                entryCount: result.slugCount,
            });
            return result;
        }).catch((err) => {
            const durationMs = Date.now() - tickStart;
            const errorCode = err !== null &&
                typeof err === "object" &&
                "code" in err &&
                typeof err.code === "string" &&
                err.code.length > 0
                ? err.code
                : "UNKNOWN";
            vtpLog.info(undefined, {
                event: "scheduler_tick",
                scheduler: "skillIndex",
                result: "error",
                durationMs,
                errorCode,
            });
            try {
                ctx.onError?.(err);
            }
            catch {
                // never throw from scheduler tick
            }
        });
    };
    // startup hook —— fire-and-forget
    runOnce();
    if (ctx.intervalHours <= 0) {
        return { stop: () => { } };
    }
    const timer = setInterval(runOnce, ctx.intervalHours * MS_PER_HOUR);
    // never block process shutdown for this maintenance timer
    timer.unref?.();
    return {
        stop: () => clearInterval(timer),
    };
}
//# sourceMappingURL=skill-index-scheduler.js.map