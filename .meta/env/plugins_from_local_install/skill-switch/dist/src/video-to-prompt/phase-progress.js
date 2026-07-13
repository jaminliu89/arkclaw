// ADR-0022: UI 进度卡数据源 = <promptDir>/phase-state.json,由 runtime 在每次
// phase emit 时同步原子写。本文件原 derivePhaseProgress 函数(基于早期事件流
// 事件回放)已删除——根因见 ADR-0022:events RPC 增量协议 + derivePhaseProgress
// 无状态化导致前端 since>0 时早期 phase 永远退化为 pending。
//
// D2-C 决策:直接删除 derivePhaseProgress (无 fallback),runtime 必须升级到
// 落 phase-state.json 的版本;旧版本 SEA binary 不写该文件 → 前端拿到全
// pending(降级但不崩)。
//
// 二期 ADR-0026 (I-3): phase 模型 6→5(DECODE/PERCEPTION/REASONING/CONSOLIDATE/
// WRITE),schemaVersion 升 2.0。readPhaseStateFile 读到老 1.0 文件(SEA binary
// 升级窗口期可能仍是一期 6 phase)时跑 upgradeV1ToV2 映射降级。
import fs from "node:fs/promises";
import path from "node:path";
// 二期 I-3 ADR-0026: 5 phase 模型 + 权重 — 与 runtime/agents/video-to-prompt/
// src/lib/phase-state.ts 严格一致。SchemaVersion 升级 1.0 → 2.0;reader
// 自动把老 1.0 文件(SEA binary 部署窗口期可能仍是一期 6 phase)按映射降级。
export const PHASE_ORDER = [
    "DECODE",
    "PERCEPTION",
    "REASONING",
    "CONSOLIDATE",
    "WRITE",
];
// equal-weighted average 不再适用 — 见 ADR-0026 权重。
export const PHASE_WEIGHTS = {
    DECODE: 3,
    PERCEPTION: 20,
    REASONING: 60,
    CONSOLIDATE: 12,
    WRITE: 5,
};
// 一期 6 phase 文件结构,用于 plugin 读老 SEA binary 写出的 phase-state.json
// (升级窗口期 plugin 已 v2 但 SEA 仍 v1)。
const LEGACY_PHASE_ORDER_V1 = [
    "decode",
    "perception",
    "keyframe",
    "ocr",
    "llm",
    "structure",
];
/**
 * 把一期 6 phase 文件映射到二期 5 phase 模型:
 *   decode → DECODE (1:1)
 *   perception/keyframe/ocr → PERCEPTION (3→1 取 max percent + 最早 startedAt)
 *   llm → REASONING (rename)
 *   (新) CONSOLIDATE — 没对应来源,填 pending (老 binary 不知道这个 phase)
 *   structure → WRITE (rename)
 */
function upgradeV1ToV2(legacy) {
    const v1 = legacy.phaseProgress;
    // PERCEPTION 合并:取 perception/keyframe/ocr 三者的 max percent;
    // status 取最进度的(running > completed > pending,failed 优先级最高)
    const triParts = [v1.perception, v1.keyframe, v1.ocr];
    const triMaxPct = Math.max(...triParts.map((p) => p.percent));
    const triStatus = triParts.some((p) => p.status === "failed")
        ? "failed"
        : triParts.every((p) => p.status === "completed")
            ? "completed"
            : triParts.some((p) => p.status === "running")
                ? "running"
                : "pending";
    const triStarted = triParts.map((p) => p.startedAt).find((s) => s !== null) ?? null;
    const triCompleted = triParts.every((p) => p.completedAt)
        ? (triParts
            .map((p) => p.completedAt)
            .filter(Boolean)
            .slice(-1)[0] ?? null)
        : null;
    return {
        schemaVersion: "2.0",
        recordingId: legacy.recordingId,
        updatedAt: legacy.updatedAt,
        phaseProgress: {
            DECODE: { ...v1.decode, phase: "DECODE" },
            PERCEPTION: {
                phase: "PERCEPTION",
                status: triStatus,
                percent: triMaxPct,
                startedAt: triStarted,
                completedAt: triCompleted,
            },
            REASONING: { ...v1.llm, phase: "REASONING" },
            CONSOLIDATE: {
                phase: "CONSOLIDATE",
                status: "pending",
                percent: 0,
                startedAt: null,
                completedAt: null,
            },
            WRITE: { ...v1.structure, phase: "WRITE" },
        },
    };
}
function emptyPhaseProgress() {
    const out = {};
    for (const phase of PHASE_ORDER) {
        out[phase] = {
            phase,
            status: "pending",
            percent: 0,
            startedAt: null,
            completedAt: null,
        };
    }
    return out;
}
/**
 * 读 <promptDir>/phase-state.json。文件缺失 / 解析失败 → 返回 null,调用方
 * 应当走"5 个 pending 兜底"路径。
 */
export async function readPhaseStateFile(promptDir) {
    try {
        const raw = await fs.readFile(path.join(promptDir, "phase-state.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed?.phaseProgress)
            return null;
        // 二期 schema 2.0: 5 phase 直接消费
        if (parsed.schemaVersion === "2.0") {
            const file = parsed;
            for (const phase of PHASE_ORDER) {
                if (!file.phaseProgress[phase])
                    return null;
            }
            return file;
        }
        // 一期 schema 1.0: 6 phase,跑 upgrade 映射到 v2 (兼容 SEA binary
        // 升级窗口期 plugin 已新 + SEA 仍旧)
        if (parsed.schemaVersion === "1.0") {
            const legacy = parsed;
            for (const phase of LEGACY_PHASE_ORDER_V1) {
                if (!legacy.phaseProgress[phase])
                    return null;
            }
            return upgradeV1ToV2(legacy);
        }
        return null;
    }
    catch {
        // 文件不存在(runtime 没启动 / 旧版 binary 不写该文件)、JSON 解析失败、
        // 权限问题等都走 null fallback。本路径绝不抛错,events RPC 必须始终响应。
        return null;
    }
}
/**
 * 把 phase-state.json 内容包装成 events RPC 响应所需的 DerivedPhaseProgress。
 *
 * 兜底语义(对齐原 derivePhaseProgress:111-118):recording.status 终态时,把仍
 * pending/running 的 phase 刷成 completed/failed。覆盖 runtime 进程异常退出
 * 没机会跑 finalize 的 case(SIGKILL / OOM / 异常崩溃)——这种情况下 runtime
 * 端 finalizePhaseState 不会执行,plugin 端兜底兜住。
 */
export function finalizedPhaseProgress(phaseFile, recordingStatus) {
    const map = phaseFile?.phaseProgress ?? emptyPhaseProgress();
    // structuredClone 避免修改 phaseFile 原对象(纯函数语义)
    const cloned = structuredClone(map);
    if (recordingStatus === "succeeded" ||
        recordingStatus === "failed" ||
        recordingStatus === "canceled") {
        for (const phase of PHASE_ORDER) {
            const slot = cloned[phase];
            if (slot.status === "pending" || slot.status === "running") {
                slot.status = recordingStatus === "succeeded" ? "completed" : "failed";
                if (slot.percent < 100 && slot.status === "completed")
                    slot.percent = 100;
            }
        }
    }
    const phaseProgress = PHASE_ORDER.map((p) => cloned[p]);
    // 二期 ADR-0026: 改 equal-weighted average → 权重 average (3/20/60/12/5)
    // 避免一期 6 phase 等权重让 REASONING(实际 60% 工作)只占 1/6 不真实。
    const totalWeight = Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0);
    const weighted = phaseProgress.reduce((acc, p) => acc + p.percent * PHASE_WEIGHTS[p.phase], 0);
    const overallPercent = Math.round(weighted / totalWeight);
    return { phaseProgress, overallPercent };
}
//# sourceMappingURL=phase-progress.js.map