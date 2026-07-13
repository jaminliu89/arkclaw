export declare const PHASE_ORDER: readonly ["DECODE", "PERCEPTION", "REASONING", "CONSOLIDATE", "WRITE"];
export type PhaseName = (typeof PHASE_ORDER)[number];
export type PhaseStatus = "pending" | "running" | "completed" | "failed";
export declare const PHASE_WEIGHTS: Record<PhaseName, number>;
export interface PhaseProgress {
    phase: PhaseName;
    status: PhaseStatus;
    percent: number;
    startedAt: string | null;
    completedAt: string | null;
}
export interface DerivedPhaseProgress {
    phaseProgress: PhaseProgress[];
    overallPercent: number;
}
export interface PhaseStateFile {
    schemaVersion: "2.0";
    recordingId: string;
    updatedAt: string;
    phaseProgress: Record<PhaseName, PhaseProgress>;
}
/**
 * 读 <promptDir>/phase-state.json。文件缺失 / 解析失败 → 返回 null,调用方
 * 应当走"5 个 pending 兜底"路径。
 */
export declare function readPhaseStateFile(promptDir: string): Promise<PhaseStateFile | null>;
/**
 * 把 phase-state.json 内容包装成 events RPC 响应所需的 DerivedPhaseProgress。
 *
 * 兜底语义(对齐原 derivePhaseProgress:111-118):recording.status 终态时,把仍
 * pending/running 的 phase 刷成 completed/failed。覆盖 runtime 进程异常退出
 * 没机会跑 finalize 的 case(SIGKILL / OOM / 异常崩溃)——这种情况下 runtime
 * 端 finalizePhaseState 不会执行,plugin 端兜底兜住。
 */
export declare function finalizedPhaseProgress(phaseFile: PhaseStateFile | null, recordingStatus: string): DerivedPhaseProgress;
//# sourceMappingURL=phase-progress.d.ts.map