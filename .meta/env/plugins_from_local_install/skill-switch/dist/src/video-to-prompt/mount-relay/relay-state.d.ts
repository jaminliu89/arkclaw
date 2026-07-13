import type { RelayStateFile } from "../types.js";
/**
 * Read relay-state.json. ENOENT → init/keepVideoOnMount=false 兜底(spec:
 * "老录制无 relay-state.json → videoRelayStatus=not_enabled")。
 * 其它 IO 错误抛出供调用方记日志。
 */
export declare function readRelayState(vtpHome: string, rid: string): Promise<RelayStateFile>;
/**
 * Atomic write relay-state.json via tmp+rename (P-04). 调用方负责保证
 * runs/<rid>/ 父目录存在 — 我们 mkdir -p 兜底以防 sweep 场景下 run 目录尚未
 * 创建。
 */
export declare function writeRelayState(vtpHome: string, rid: string, state: RelayStateFile): Promise<void>;
export declare function safeUnlinkRelayMountVideo(rid: string, relay: RelayStateFile, fallbackMountPath?: string): Promise<{
    deleted: boolean;
    missing: boolean;
    unsafe: boolean;
    error?: Error;
}>;
/**
 * Plugin 启动钩子:扫所有 runs/<rid>/relay-state.json,把 status="pending"
 * 的标为 failed + errorCode=RESTART_INTERRUPTED(spec "启动扫描")。
 *
 * completed / failed / init 一律不动。runs 目录缺失或部分 rid 缺 relay-state
 * 时 best-effort 静默跳过,不阻塞 plugin 启动。
 */
export declare function sweepInterruptedRelays(vtpHome: string): Promise<{
    swept: number;
}>;
//# sourceMappingURL=relay-state.d.ts.map