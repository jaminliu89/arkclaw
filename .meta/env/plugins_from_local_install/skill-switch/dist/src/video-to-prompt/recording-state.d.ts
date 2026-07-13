import type { RecordingMetadata, RecordingStatus, RecordingView } from "./types.js";
import { type ReferenceSkillEntry } from "./recording-index.js";
export declare function getActiveRecording(stateDir: string): Promise<RecordingMetadata | null>;
export declare function getRecording(stateDir: string, recordingId: string): Promise<RecordingMetadata | null>;
export declare function listRecordings(stateDir: string): Promise<RecordingMetadata[]>;
export type DefaultRecordingPick = "latest-stopped" | "resumable-stopped" | "latest-completed" | "in-flight-task";
export declare function pickDefaultRecording(stateDir: string, intent: DefaultRecordingPick): Promise<RecordingMetadata | null>;
export declare function upsertRecording(stateDir: string, recording: RecordingMetadata, opts?: {
    setActive?: boolean;
}): Promise<void>;
export declare function patchRecording(stateDir: string, recordingId: string, patch: Partial<RecordingMetadata>): Promise<RecordingMetadata | null>;
export declare function patchRecordingIfStatus(stateDir: string, recordingId: string, expectedStatuses: readonly RecordingStatus[], patch: Partial<RecordingMetadata>): Promise<RecordingMetadata | null>;
export declare function clearActiveRecording(stateDir: string): Promise<void>;
/**
 * 二期 F-B (D-20 双域解耦):删除 state.recordings 条目。
 * delete RPC 方案 B + cleanup-scheduler 扩范围 共用。原子写,清 activeRecordingId
 * 若指向被删 rid。任务模板域 reference/<slug>/ 不动 (调用方负责)。
 */
export declare function removeRecording(stateDir: string, recordingId: string): Promise<boolean>;
export declare function generateRecordingId(): string;
export declare function isProcessAlive(pid: number | undefined): boolean;
export declare function reconcileOnStartup(stateDir: string): Promise<{
    patched: number;
}>;
import { buildInvocations } from "./recording-invocations.js";
export { buildInvocations };
/**
 * Synthesize a unified RecordingView from state.json + side artifacts. Used
 * by every arkclawVtpRecording.* RPC so the front-end can render against a
 * stable shape regardless of which RPC produced it. Reads filesystem lazily
 * and tolerates missing files (returns null fields instead of throwing).
 *
 * Note: invocations is initialised to null here — list RPC post-processes the
 * full set with global taskName uniqueness map and overrides this field. Other
 * RPCs (status / start / stop / etc.) leave it null since they only see one
 * recording at a time and can't determine global uniqueness.
 */
export declare function buildRecordingView(stateDir: string, recordingId: string, vtpHome?: string): Promise<RecordingView | null>;
export declare function readRelayFieldsForView(vtpHome: string | undefined, recordingId: string): Promise<{
    videoRelayStatus: "not_enabled" | "pending" | "completed" | "failed";
    videoMountRelativePath: string | null;
    videoMountFullPath: string | null;
    videoRelayError: {
        code: string;
        message: string;
    } | null;
    keepVideoOnMount: boolean;
    videoRelayProgress: number | null;
}>;
/**
 * Single CAS source of truth for "promote analyzing/stopped to terminal status
 * based on meta.json". Returns whether THIS call won the CAS — callers whose
 * side effects (metric / audit / cleanup mp4) must fire exactly once per
 * terminal transition gate them on `transitioned === true`.
 *
 * Read RPCs that only need the reconciled recording should use the
 * `deriveStatusFromMeta` wrapper below, which discards the transition flag.
 *
 * Terminal non-regression: the status guard at top + CAS allowlist
 * ["analyzing", "stopped"] together guarantee already-terminal recordings
 * (succeeded/failed/canceled) are never overwritten. `stopped` is not in
 * ACTIVE_STATUSES but may legally progress to terminal when an out-of-band
 * analyzer (e.g. resumable-stopped path) writes meta.json — kept in the
 * allowlist for that case.
 *
 * Side effect: persists new status via patchRecordingIfStatus (lock-safe).
 * endedAt is preserved if already set, mirroring watchdog success / zombie
 * recovery / startup reconcile so a stop-time timestamp isn't reset.
 */
export declare function deriveStatusFromMetaTransition(stateDir: string, target: RecordingMetadata): Promise<{
    recording: RecordingMetadata;
    transitioned: boolean;
    terminalStatus?: "succeeded" | "failed";
}>;
/**
 * Read-RPC convenience wrapper around `deriveStatusFromMetaTransition`. Use
 * this when only the reconciled recording matters. Callers that must gate
 * side effects on winning the CAS transition (e.g. watchdog non-zero + terminal
 * meta metric/cleanup) must call `deriveStatusFromMetaTransition` directly and
 * inspect `transitioned`.
 *
 * Called from: status / events / result / cancel handlers + start gate
 * (via resolveInFlightAfterMeta).
 */
export declare function deriveStatusFromMeta(stateDir: string, target: RecordingMetadata): Promise<RecordingMetadata>;
/**
 * Start-gate helper: returns the currently in-flight task that should block a
 * fresh `start`, or null if no such task exists. Combines pickDefaultRecording
 * with lazy meta-derive so stale `analyzing` records whose runtime already
 * wrote terminal meta.json don't permanently block new starts.
 *
 * Used by both slash command (recording-lifecycle.ts handleStart) and RPC
 * (gateway-handlers/start.ts) so the two entry points cannot drift on
 * stale-state handling.
 *
 * Returns null when:
 *   - no in-flight task selected by pickDefaultRecording, or
 *   - in-flight task was reconciled to a terminal state (succeeded/failed/
 *     canceled) and is no longer active.
 *
 * Returns the (possibly reconciled) recording when it remains active —
 * caller renders a "task is already <status>" error to the user.
 */
export declare function resolveInFlightAfterMeta(stateDir: string): Promise<RecordingMetadata | null>;
/**
 * Convert an on-disk ReferenceSkillEntry (saveAsSkill artifact) into the same
 * RecordingView shape consumed by the front-end. Status is forced to
 * "succeeded" because reference entries are by definition saved-after-success
 * — without this, sort-by-status / status-filter would surface them under
 * whatever stale status meta.json happened to record.
 */
export declare function convertReferenceToView(ref: ReferenceSkillEntry): RecordingView;
//# sourceMappingURL=recording-state.d.ts.map