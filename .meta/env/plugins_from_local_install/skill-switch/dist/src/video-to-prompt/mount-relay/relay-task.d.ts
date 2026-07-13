/**
 * relayVideoToMount 入参。startedAtIso 由调用方从 recording.startedAt 取,
 * 不在本模块查 state(模块职责单一,便于单测)。
 */
export interface RelayInput {
    vtpHome: string;
    recordingId: string;
    sourceVideoPath: string;
    mountPath: string;
    startedAtIso: string;
    keepVideoOnMount: boolean;
    /** 默认 600_000ms(10 min),test 用 0 触发超时 */
    timeoutMs?: number;
}
export type RelayResult = {
    ok: true;
    mountRelativePath: string;
    mountFullPath: string;
} | {
    ok: false;
    errorCode: string;
    errorMessage: string;
};
/** 仅 test 用:重置 inflight Map,防止跨 case 串味 */
export declare function __resetInflightForTest(): void;
export declare function __setBeforeCopyHookForTest(hook: (() => Promise<void> | void) | undefined): void;
/**
 * 查在途 relay 的目标 mountPath(无在途则 undefined)。saveVideoToMount handler
 * 在 detach 后台 relay 前用它做并发判定 —— 在途 relay 指向别的挂载点时直接回
 * RELAY_BUSY,不进入会互相覆盖 relay-state.json 的并发。
 */
export declare function peekRelayInflight(recordingId: string): {
    mountPath: string;
} | undefined;
export declare function abortRelayForRecording(recordingId: string): Promise<{
    aborted: boolean;
}>;
/**
 * CAS 守卫进度写入(Issue 2 Option A)。
 *
 * onProgress 回调 fire-and-forget 调本函数。写前先读盘:若终态
 * completed/failed 已落盘则 no-op,防止晚到的进度写把终态回退成 pending。
 *
 * 提取为 export 函数以便单测直接覆盖真实 CAS 路径(而非在测试里手工复刻)。
 * relay-task.ts 的 onProgress 闭包直接委托给本函数。
 */
export declare function writeProgressStateGuarded(vtpHome: string, recordingId: string, percent: number, startedAt: string, keepVideoOnMount: boolean): Promise<void>;
/**
 * Public entry. P-01 inflight gate:同 rid 并发复用 promise(spec "saveVideo
 * ToMount 同 recordingId 并发中继去重")。
 *
 * 注意:**不能**声明为 `async function`。async 函数每次调用都会创建一个
 * 新的 Promise wrapper,即使内部 `return existing` 也会被包成新 Promise,
 * 导致 `p1 === p2` 失败、调用方无法用 reference identity 验证去重生效。
 * 这里保持普通 function 返回 Promise,让 `return existing` 真正复用引用。
 */
export declare function relayVideoToMount(input: RelayInput): Promise<RelayResult>;
//# sourceMappingURL=relay-task.d.ts.map