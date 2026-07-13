import type { OpenClawPluginApi } from "./types.js";
/**
 * 二期 F-B: 一期 pruneOldRecordingVideos + pruneOldPromptDirs 已被
 * pruneOldRecordings (上文) 合并替代,按 endedAt > recordingRetentionDays
 * 清整个 runs/<rid>/ + state.recordings 条目。
 */
/**
 * Recursive directory removal that lstat's every entry and refuses to follow
 * symbolic links (R4 C-③). Use instead of fs.rm({recursive:true}) which
 * follows links inside the tree and could be tricked into deleting outside
 * the cleanup root.
 *
 * R11 P1-②: exported so skill-persistence.ts (LRU eviction in saveAsSkill)
 * can use it instead of the unsafe fs.rm({recursive:true,force:true}). LRU
 * deletes touch workspace-resident dirs that an adversary or model could have
 * populated with symlinks pointing at /root/.ssh / etc.
 */
export interface SafeRecursiveRmError {
    op: "lstat" | "readdir" | "unlink" | "rmdir";
    path: string;
    message: string;
    code?: string;
}
export interface SafeRecursiveRmResult {
    removed: boolean;
    missing: boolean;
    errors: SafeRecursiveRmError[];
}
export interface SafeRecursiveRmOptions {
    depth?: number;
    expectedRoot?: {
        dev: number;
        ino: number;
    };
}
export declare function safeRecursiveRm(dir: string, optsOrDepth?: SafeRecursiveRmOptions | number): Promise<SafeRecursiveRmResult>;
/**
 * Install startup + periodic maintenance.
 *   - startup sweep: fire-and-forget once (reconcile + full cleanup pass)
 *   - periodic sweep: every 1h via setInterval().unref() so the timer never
 *     prevents Node.js from exiting when the plugin is torn down
 *
 * Returns a teardown function for tests; production callers fire-and-forget.
 */
export declare function startMaintenanceScheduler(api: OpenClawPluginApi): () => void;
//# sourceMappingURL=cleanup-scheduler.d.ts.map