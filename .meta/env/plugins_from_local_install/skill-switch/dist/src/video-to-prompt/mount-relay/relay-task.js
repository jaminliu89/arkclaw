// VTP F-A saveVideoToMount 中继任务核心。
//
// 职责:把本地 $VTP_HOME/runs/<rid>/video.mp4 拷贝到挂载点
// <mountPath>/vtp/<YYYY-MM>/<rid>.mp4(ADR-0024 路径规则)。
//
// 关键约束:
//   - PATTERN P-01 inflight gate:同 rid 并发去重(spec "同 recordingId
//     并发中继去重")
//   - fs.lstat 拒 symlink:源 mp4 不能是符号链接(spec "源 mp4 symlink 拒绝";
//     ADR-0019 sandbox 防护)
//   - 超时:默认 10 min(configSchema.relayTimeoutSeconds=600),从一期 30s 拉宽
//     (二期 R-1 决策)
//   - 错误码:SYMLINK_REJECTED / SOURCE_NOT_FILE / SOURCE_NOT_FOUND /
//     MOUNT_INACCESSIBLE / RELAY_TIMEOUT / RELAY_IO_ERROR
//
// 写入序列(均经 P-04 atomic):
//   1) relay-state.json pending(开始时)
//   2) stream pipeline copy (read → progressTransform → write, AbortController timeout)
//   3) relay-state.json completed | failed(结束时)
//
// CAS 守卫(Issue 2 修复):onProgress 回调写 pending+progress 在 stream copy
// 期间 fire-and-forget,晚到的进度写的 tmp→rename 可能晚于终态 completed/
// failed 的 rename 落盘,把终态回退到 pending。双层防护:
//   A) 写前先读盘,current.status !== "pending" 时 no-op(CAS 守卫)
//   B) 进度写串行化为 promise-chain(PATTERN P-01),终态写前 drain 整条链
//      → 零进度写在途,根除"早期未追踪写晚于终态"窗口(旧实现只 await
//      最后一次进度写,早于它的写不被追踪 → 仍能回退终态)
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as path from "node:path";
import * as os from "node:os";
import { readRelayState, writeRelayState } from "./relay-state.js";
import { withVtpSpan } from "../observability/tracer.js";
import { recordHistogram } from "../observability/metrics.js";
import { vtpLog } from "../observability/logger.js";
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min,与 configSchema.relayTimeoutSeconds 默认值对齐
// PATTERN P-01: per-recordingId inflight gate。Map key 是 recordingId,value
// 记在途 relay 的目标 mountPath + promise。relay-state.json 是「单 recording
// 单文件」,无法表达一个 rid 同时中继到多个挂载点 —— 并发写会 last-writer-wins
// 互相覆盖 status / progress / mountAbsolutePath。故:同 rid+同 mountPath 并发
// → 复用 promise 去重;同 rid+不同 mountPath 并发 → 拒绝 RELAY_BUSY。
const relayInflight = new Map();
function currentInflightKeepIntent(recordingId, fallback) {
    return relayInflight.get(recordingId)?.keepVideoOnMount ?? fallback;
}
/** 仅 test 用:重置 inflight Map,防止跨 case 串味 */
export function __resetInflightForTest() {
    relayInflight.clear();
}
let beforeCopyHookForTest;
export function __setBeforeCopyHookForTest(hook) {
    beforeCopyHookForTest = hook;
}
/**
 * 查在途 relay 的目标 mountPath(无在途则 undefined)。saveVideoToMount handler
 * 在 detach 后台 relay 前用它做并发判定 —— 在途 relay 指向别的挂载点时直接回
 * RELAY_BUSY,不进入会互相覆盖 relay-state.json 的并发。
 */
export function peekRelayInflight(recordingId) {
    const e = relayInflight.get(recordingId);
    return e ? { mountPath: e.mountPath } : undefined;
}
export async function abortRelayForRecording(recordingId) {
    const e = relayInflight.get(recordingId);
    if (!e)
        return { aborted: false };
    e.abortController.abort();
    await e.promise.catch(() => undefined);
    return { aborted: true };
}
/**
 * 拼挂载点完整路径:<mountPath>/vtp/<YYYY-MM>/<rid>.mp4(ADR-0024)。
 * - mountPath trailing slash normalize(path.join 自动)
 * - 月份从 startedAt 取(幂等;同一 rid 多次调路径不变)
 */
function buildMountPaths(mountPath, startedAtIso, recordingId) {
    const month = startedAtIso.slice(0, 7); // "YYYY-MM"
    // L8: startedAtIso 来自 rec.startedAt(handleStart 的 toISOString),
    // 正常恒为合法 ISO;断言 YYYY-MM 前缀作防御 —— 一旦异常输入混入,
    // 宁可显式失败也不要把 mp4 写到形如 <mountPath>/vtp/garbage/ 的路径。
    if (!/^\d{4}-\d{2}$/.test(month)) {
        throw new Error(`buildMountPaths: startedAtIso ${startedAtIso} 缺合法 YYYY-MM 前缀`);
    }
    const relative = path.posix.join("vtp", month, `${recordingId}.mp4`);
    const dir = path.join(mountPath, "vtp", month);
    const full = path.join(dir, `${recordingId}.mp4`);
    return { relative, full, dir };
}
/**
 * fs.lstat 校验源文件:必须存在 + 必须不是 symlink(spec "源 mp4 symlink
 * 拒绝";ADR-0019 sandbox)。
 */
async function assertSourceSafe(srcPath) {
    try {
        const st = await fs.lstat(srcPath);
        if (st.isSymbolicLink()) {
            return {
                ok: false,
                errorCode: "SYMLINK_REJECTED",
                errorMessage: `source mp4 is a symlink (refused): ${srcPath}`,
            };
        }
        if (!st.isFile()) {
            return {
                ok: false,
                errorCode: "SOURCE_NOT_FILE",
                errorMessage: `source mp4 is not a regular file: ${srcPath}`,
            };
        }
        return null;
    }
    catch (err) {
        return {
            ok: false,
            errorCode: "SOURCE_NOT_FOUND",
            errorMessage: `source mp4 not accessible: ${err.message}`,
        };
    }
}
/**
 * 校验 mountPath 父目录可访问(spec "mountPath 不存在 →
 * MOUNT_INACCESSIBLE")。
 */
async function assertMountAccessible(mountPath) {
    if (!path.isAbsolute(mountPath)) {
        return {
            ok: false,
            errorCode: "MOUNT_INACCESSIBLE",
            errorMessage: `mountPath must be an absolute path: ${mountPath}`,
        };
    }
    try {
        const st = await fs.lstat(mountPath);
        if (st.isSymbolicLink()) {
            return {
                ok: false,
                errorCode: "MOUNT_INACCESSIBLE",
                errorMessage: `mountPath is a symlink (refused): ${mountPath}`,
            };
        }
        if (!st.isDirectory()) {
            return {
                ok: false,
                errorCode: "MOUNT_INACCESSIBLE",
                errorMessage: `mountPath is not a directory: ${mountPath}`,
            };
        }
        const realMountPath = await fs.realpath(mountPath);
        const root = path.parse(realMountPath).root;
        const dangerousRoots = new Set([root, os.homedir()]);
        if (dangerousRoots.has(realMountPath)) {
            return {
                ok: false,
                errorCode: "MOUNT_INACCESSIBLE",
                errorMessage: `mountPath is too broad/dangerous: ${realMountPath}`,
            };
        }
        return { realMountPath };
    }
    catch (err) {
        return {
            ok: false,
            errorCode: "MOUNT_INACCESSIBLE",
            errorMessage: `mountPath not accessible: ${err.message}`,
        };
    }
}
/**
 * 中间路径组件 + 目标文件逐个 lstat 拒 symlink(ADR-0018 / ADR-0019)。
 *
 * assertMountAccessible 只校验 mountPath 本身,但真实写入目标是
 * <mountPath>/vtp/<YYYY-MM>/<rid>.mp4 —— fs.mkdir(recursive) 与
 * createWriteStream 都会跟随中间 symlink。若 <mountPath>/vtp(或目标
 * 文件本身)被预先替换成 symlink,relay mp4 会被写出挂载根外。
 *
 * 调用时机:mkdir 之后。此时 <mountPath>/vtp 与 dir 均存在 —— mkdir
 * 新建的是真目录(lstat pass);预先植入的 symlink 即便被 mkdir 跟随,
 * 其自身 lstat 仍报 isSymbolicLink → 拒。full(.mp4)拷贝前尚不存在,
 * 若已存在(re-relay)且是 symlink 同样拒。
 */
async function assertMountPathSafe(mountPath, dir, full) {
    const components = [path.join(mountPath, "vtp"), dir, full];
    for (const comp of components) {
        try {
            const st = await fs.lstat(comp);
            if (st.isSymbolicLink()) {
                return {
                    ok: false,
                    errorCode: "SYMLINK_REJECTED",
                    errorMessage: `mount path component is a symlink (refused): ${comp}`,
                };
            }
        }
        catch {
            // 组件不存在 → mkdir 已建/拷贝将建真节点,无 symlink 风险
        }
    }
    return null;
}
async function resolveSafeMountOutputPath(mountPath, dir, full) {
    try {
        const realMountPath = await fs.realpath(mountPath);
        const realDir = await fs.realpath(dir);
        const expectedRealDir = path.join(realMountPath, "vtp", path.basename(dir));
        if (realDir !== expectedRealDir ||
            !realDir.startsWith(realMountPath + path.sep)) {
            return {
                ok: false,
                errorCode: "SYMLINK_REJECTED",
                errorMessage: `mount output dir escaped mount root (refused): ${dir}`,
            };
        }
        return { ok: true, realDir, full: path.join(realDir, path.basename(full)) };
    }
    catch (err) {
        return {
            ok: false,
            errorCode: "MOUNT_INACCESSIBLE",
            errorMessage: `mount output dir realpath failed: ${err.message}`,
        };
    }
}
/**
 * fs.copyFile 包装 AbortSignal.timeout。超时 → 取消任务、清理半成品、
 * 返回 RELAY_TIMEOUT(spec "拷贝 30s 超时" → 二期 R-1 改为可配置默认 5 min)。
 */
async function copyWithTimeout(src, dest, timeoutMs, abortSignal, onProgress, expectedDestDirRealPath) {
    let srcHandle;
    try {
        if (expectedDestDirRealPath) {
            const realDestDir = await fs.realpath(path.dirname(dest));
            if (realDestDir !== expectedDestDirRealPath) {
                return {
                    ok: false,
                    errorCode: "SYMLINK_REJECTED",
                    errorMessage: `relay dest dir changed after safety check (refused): ${path.dirname(dest)}`,
                };
            }
        }
        // #4: src 也用 O_NOFOLLOW 打开 — 与下方 dest 的 H2 防护对称。
        // assertSourceSafe 的 lstat-gate 与此处 open 之间有 TOCTOU 窗口,源
        // video.mp4 被换成 symlink 时 createReadStream(path) 会跟随、把任意
        // 文件内容(如 /etc/shadow)拷进挂载点。O_NOFOLLOW 让 open 命中末段
        // symlink 时直接 ELOOP 失败。stat / read 全部走该 fd,不再二次按路径解析。
        srcHandle = await fs.open(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        // I-1: stream pipeline 替代 fs.copyFile,获取真实字节进度 + AbortSignal
        // 原生超时;Transform stream 仅做透传 + 累计 bytesWritten,通过
        // onProgress 回调 throttle 写到 relay-state.json,前端拿到上传 %。
        const stat = await srcHandle.stat();
        const totalBytes = stat.size;
        let bytesWritten = 0;
        let lastProgressEmit = -1; // 上次 emit 的整数百分比,避免高频写盘
        const progressTransform = new Transform({
            transform(chunk, _enc, cb) {
                bytesWritten += chunk.length;
                if (onProgress && totalBytes > 0) {
                    const pct = Math.min(99, // 99 上限;100 留给写完 relay-state.json:completed
                    Math.floor((bytesWritten / totalBytes) * 100));
                    // throttle: 仅在 % 整数变化(且 5% 增量)时 emit;避免 5MB 视频
                    // 几十次 atomic write 抖盘
                    if (pct >= lastProgressEmit + 5) {
                        lastProgressEmit = pct;
                        onProgress(pct);
                    }
                }
                cb(null, chunk);
            },
        });
        // H2: 先写同目录唯一 temp,再 rename 覆盖最终 .mp4。相比直接
        // O_TRUNC dest,这不会截断预置 hardlink 指向的外部 inode；O_NOFOLLOW
        // 仍保证 temp 末段不会跟随 symlink。中间目录组件的 TOCTOU 由
        // assertMountPathSafe 的 lstat 覆盖 — O_NOFOLLOW 不查中间段。
        // F-2 (review V5): crypto.randomBytes 替代 Math.random,与 helpers.ts /
        // skill-persistence.ts 同款 atomic 写一致 (see relay-state.ts:writeRelayState
        // 同款修复)。O_NOFOLLOW + O_EXCL 已兜底实际攻击面。
        const tempDest = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}`);
        const destHandle = await fs.open(tempDest, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW);
        const ac = new AbortController();
        const abortFromCaller = () => ac.abort();
        abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
            await pipeline(srcHandle.createReadStream(), progressTransform, destHandle.createWriteStream(), { signal: ac.signal });
            if (expectedDestDirRealPath) {
                const realDestDir = await fs.realpath(path.dirname(dest));
                if (realDestDir !== expectedDestDirRealPath) {
                    await fs.unlink(tempDest).catch(() => { });
                    return {
                        ok: false,
                        errorCode: "SYMLINK_REJECTED",
                        errorMessage: `relay dest dir changed before rename (refused): ${path.dirname(dest)}`,
                    };
                }
            }
            await fs.rename(tempDest, dest);
        }
        finally {
            clearTimeout(timer);
            abortSignal?.removeEventListener("abort", abortFromCaller);
            await destHandle.close().catch(() => { });
        }
        return null;
    }
    catch (err) {
        // C-I6: copy 始终写同目录临时文件,失败时不碰既有 dest(可能是用户保留
        // 的旧文件或 hardlink);尽力清理本次 temp 残片。
        await fs
            .readdir(path.dirname(dest))
            .then((entries) => Promise.all(entries
            .filter((entry) => entry.startsWith(`.${path.basename(dest)}.tmp.`))
            .map((entry) => fs.unlink(path.join(path.dirname(dest), entry)).catch(() => { }))))
            .catch(() => { });
        const errAny = err;
        // H2 / #4: O_NOFOLLOW 命中 symlink 末段 → ELOOP(src 或 dest 任一)。
        if (errAny.code === "ELOOP") {
            return {
                ok: false,
                errorCode: "SYMLINK_REJECTED",
                errorMessage: `relay source or dest is a symlink (refused)`,
            };
        }
        // AbortSignal 触发 → name=AbortError / code=ABORT_ERR
        if (errAny.name === "AbortError" || errAny.code === "ABORT_ERR") {
            if (abortSignal?.aborted) {
                return {
                    ok: false,
                    errorCode: "RELAY_ABORTED",
                    errorMessage: "relay aborted by recording delete",
                };
            }
            return {
                ok: false,
                errorCode: "RELAY_TIMEOUT",
                errorMessage: `relay copy exceeded ${timeoutMs}ms timeout`,
            };
        }
        const code = errAny.code ?? "RELAY_IO_ERROR";
        return {
            ok: false,
            errorCode: code === "ENOSPC"
                ? "DISK_FULL"
                : code === "EACCES"
                    ? "PERMISSION_DENIED"
                    : "RELAY_IO_ERROR",
            errorMessage: `copy failed: ${err.message}`,
        };
    }
    finally {
        // #4: 释放 srcHandle(O_NOFOLLOW 打开的源 fd)。destHandle 由内层
        // finally 关闭;srcHandle 跨越内层 try,在此外层 finally 兜底关闭。
        await srcHandle?.close().catch(() => { });
    }
}
/**
 * CAS 守卫进度写入(Issue 2 Option A)。
 *
 * onProgress 回调 fire-and-forget 调本函数。写前先读盘:若终态
 * completed/failed 已落盘则 no-op,防止晚到的进度写把终态回退成 pending。
 *
 * 提取为 export 函数以便单测直接覆盖真实 CAS 路径(而非在测试里手工复刻)。
 * relay-task.ts 的 onProgress 闭包直接委托给本函数。
 */
export async function writeProgressStateGuarded(vtpHome, recordingId, percent, startedAt, keepVideoOnMount) {
    const current = await readRelayState(vtpHome, recordingId);
    if (current.status !== "pending") {
        // 终态已写盘,进度写 no-op(CAS 守卫生效)
        return;
    }
    await writeRelayState(vtpHome, recordingId, {
        status: "pending",
        keepVideoOnMount: currentInflightKeepIntent(recordingId, current.keepVideoOnMount ?? keepVideoOnMount),
        startedAt,
        progress: percent,
    });
}
/**
 * relayVideoToMount 内部实现(已经过 inflight gate)。
 */
async function relayInner(input, abortSignal) {
    const { vtpHome, recordingId, sourceVideoPath, mountPath, startedAtIso, keepVideoOnMount, timeoutMs = DEFAULT_TIMEOUT_MS, } = input;
    return withVtpSpan("vtp.video.copy", { run_id: recordingId, "vtp.recording_id": recordingId }, async (span) => {
        const relayStartMs = Date.now();
        // 写 pending state
        const startedAt = new Date().toISOString();
        const pendingState = {
            status: "pending",
            keepVideoOnMount,
            startedAt,
        };
        try {
            await writeRelayState(vtpHome, recordingId, pendingState);
        }
        catch (err) {
            const fail = {
                ok: false,
                errorCode: "RELAY_IO_ERROR",
                errorMessage: `writeRelayState(pending) failed: ${err.message}`,
            };
            finalize("failed", Date.now() - relayStartMs);
            return fail;
        }
        // helper: record metric + set span attribute on any terminal outcome
        function finalize(result, durationMs) {
            try {
                span.setAttribute("vtp.relay_status", result);
            }
            catch {
                // silent — instrumentation must not mask business result
            }
            try {
                recordHistogram("vtp.relay.duration", durationMs, { result });
            }
            catch {
                // silent
            }
        }
        // 1) symlink 拒
        const srcFail = await assertSourceSafe(sourceVideoPath);
        if (srcFail) {
            await writeFailedState(vtpHome, recordingId, srcFail, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return srcFail;
        }
        // 2) mountPath 可访问
        const mountCheck = await assertMountAccessible(mountPath);
        if ("ok" in mountCheck) {
            await writeFailedState(vtpHome, recordingId, mountCheck, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return mountCheck;
        }
        // 3) 拼路径 + 建月份子目录
        const paths = buildMountPaths(mountCheck.realMountPath, startedAtIso, recordingId);
        // 3.0) D.3 (review 2026-05-24, #15): mkdir(recursive) follows
        // pre-existing symlinks. If <realMount>/vtp or <realMount>/vtp/YYYY-MM
        // was pre-planted as a symlink to a directory outside the mount
        // root, fs.mkdir would create the leaf inside that escape target
        // before the post-mkdir assertMountPathSafe rejects the copy.
        // Pre-check existing parent components and refuse if any is a
        // symlink. The post-mkdir assertMountPathSafe + resolveSafeMount-
        // OutputPath are retained as defense-in-depth for the residual
        // TOCTOU window between this check and mkdir.
        for (const comp of [
            path.join(mountCheck.realMountPath, "vtp"),
            paths.dir,
        ]) {
            try {
                const compStat = await fs.lstat(comp);
                if (compStat.isSymbolicLink()) {
                    const fail = {
                        ok: false,
                        errorCode: "SYMLINK_REJECTED",
                        errorMessage: `pre-mkdir component is a symlink: ${comp}`,
                    };
                    await writeFailedState(vtpHome, recordingId, fail, keepVideoOnMount, startedAt);
                    finalize("failed", Date.now() - relayStartMs);
                    return fail;
                }
            }
            catch (err) {
                if (err.code !== "ENOENT") {
                    const fail = {
                        ok: false,
                        errorCode: "MOUNT_INACCESSIBLE",
                        errorMessage: `pre-mkdir lstat failed for ${comp}: ${err.message}`,
                    };
                    await writeFailedState(vtpHome, recordingId, fail, keepVideoOnMount, startedAt);
                    finalize("failed", Date.now() - relayStartMs);
                    return fail;
                }
                // ENOENT — component will be created safely by mkdir below.
            }
        }
        try {
            await fs.mkdir(paths.dir, { recursive: true });
        }
        catch (err) {
            const fail = {
                ok: false,
                errorCode: "MOUNT_INACCESSIBLE",
                errorMessage: `mkdir failed: ${err.message}`,
            };
            await writeFailedState(vtpHome, recordingId, fail, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return fail;
        }
        // 3.5) 中间路径组件 symlink 拒(ADR-0018):mkdir 之后逐组件
        // lstat,防止 <mountPath>/vtp 或目标文件被预置 symlink 把 mp4
        // 写出挂载根外。
        const pathFail = await assertMountPathSafe(mountCheck.realMountPath, paths.dir, paths.full);
        if (pathFail) {
            await writeFailedState(vtpHome, recordingId, pathFail, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return pathFail;
        }
        const safeOutput = await resolveSafeMountOutputPath(mountCheck.realMountPath, paths.dir, paths.full);
        if (!safeOutput.ok) {
            await writeFailedState(vtpHome, recordingId, safeOutput, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return safeOutput;
        }
        await beforeCopyHookForTest?.();
        const pathFailAfterHook = await assertMountPathSafe(mountCheck.realMountPath, paths.dir, paths.full);
        if (pathFailAfterHook) {
            await writeFailedState(vtpHome, recordingId, pathFailAfterHook, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return pathFailAfterHook;
        }
        const safeOutputAfterHook = await resolveSafeMountOutputPath(mountCheck.realMountPath, paths.dir, paths.full);
        if (!safeOutputAfterHook.ok) {
            await writeFailedState(vtpHome, recordingId, safeOutputAfterHook, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return safeOutputAfterHook;
        }
        // 4) 拷贝 with timeout + progress (I-1)
        // onProgress 回调 throttle 写 relay-state.json,buildRecordingView 在
        // status=pending 时把 progress 透传到 RecordingView.videoRelayProgress。
        // throttle 已在 copyWithTimeout 内做(5% 增量)。
        //
        // 进度写串行化(PATTERN P-01 promise-chain):onProgress 回调把
        // 每次进度写 append 到 chain 尾部,严格串行 → 任意时刻最多一个
        // 进度写在途。终态写前 await 整条链,保证所有进度写已落盘,
        // 不会有"早于最后一次、已过 CAS 读但未 rename"的进度写晚于终态
        // 落盘。
        let progressWriteChain = Promise.resolve();
        const copyFail = await copyWithTimeout(sourceVideoPath, safeOutputAfterHook.full, timeoutMs, abortSignal, (percent) => {
            // 委托给 writeProgressStateGuarded(CAS 守卫:读盘确认仍是
            // pending 才写)。串行 append 到 chain,终态前整体 drain。
            progressWriteChain = progressWriteChain.then(() => writeProgressStateGuarded(vtpHome, recordingId, percent, startedAt, keepVideoOnMount).catch(() => {
                /* best-effort, progress 写失败不影响 copy */
            }));
        }, safeOutputAfterHook.realDir);
        // 终态写前必须完整 drain 进度写链。若某次进度写已通过 CAS 读盘
        // (看到 pending)但 rename 被 IO 延迟卡住,此时超时放行写终态会让
        // 迟到的 pending+progress 在终态之后落盘,把 completed/failed 回退为
        // pending。因此这里不做 Promise.race 超时兜底;进度写自身已 catch 成
        // best-effort,正常不会因单次失败拖垮主链路。
        await progressWriteChain;
        if (copyFail) {
            await writeFailedState(vtpHome, recordingId, copyFail, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return copyFail;
        }
        if (abortSignal?.aborted) {
            await fs.unlink(safeOutputAfterHook.full).catch(() => { });
            const abortFail = {
                ok: false,
                errorCode: "RELAY_ABORTED",
                errorMessage: "relay aborted by recording delete",
            };
            await writeFailedState(vtpHome, recordingId, abortFail, keepVideoOnMount, startedAt);
            finalize("failed", Date.now() - relayStartMs);
            return abortFail;
        }
        // 5) 写 completed state (含 mountAbsolutePath 持久化,见 spec
        //    "Requirement: RecordingView 暴露视频中继字段 + 完整路径"
        //    —— 已上传视频的位置在 plugin 重启 / 切机器后不变,绝对路径必须落盘)
        try {
            const latest = await readRelayState(vtpHome, recordingId).catch(() => null);
            const latestKeep = currentInflightKeepIntent(recordingId, latest?.status === "pending"
                ? latest.keepVideoOnMount
                : keepVideoOnMount);
            await writeRelayState(vtpHome, recordingId, {
                status: "completed",
                keepVideoOnMount: latestKeep,
                mountRelativePath: paths.relative,
                mountAbsolutePath: safeOutputAfterHook.full,
                mountRootRealPath: mountCheck.realMountPath,
                startedAt,
                completedAt: new Date().toISOString(),
            });
        }
        catch (err) {
            const fail = {
                ok: false,
                errorCode: "RELAY_IO_ERROR",
                errorMessage: `writeRelayState(completed) failed: ${err.message}`,
            };
            finalize("failed", Date.now() - relayStartMs);
            return fail;
        }
        // Audit log: pending → completed
        try {
            vtpLog.info({ rid: recordingId }, {
                event: "state_transition",
                dimension: "relay",
                from: "pending",
                to: "completed",
            });
        }
        catch {
            // silent
        }
        finalize("completed", Date.now() - relayStartMs);
        return {
            ok: true,
            mountRelativePath: paths.relative,
            mountFullPath: safeOutputAfterHook.full,
        };
    });
}
async function writeFailedState(vtpHome, recordingId, fail, keepVideoOnMount, startedAt) {
    const latest = await readRelayState(vtpHome, recordingId).catch(() => null);
    const latestKeep = currentInflightKeepIntent(recordingId, latest?.status === "pending" ? latest.keepVideoOnMount : keepVideoOnMount);
    await writeRelayState(vtpHome, recordingId, {
        status: "failed",
        keepVideoOnMount: latestKeep,
        errorCode: fail.errorCode,
        errorMessage: fail.errorMessage,
        startedAt,
        completedAt: new Date().toISOString(),
    });
    // Audit log: pending → failed
    try {
        vtpLog.info({ rid: recordingId }, {
            event: "state_transition",
            dimension: "relay",
            from: "pending",
            to: "failed",
            errorCode: fail.errorCode,
            errorMessage: fail.errorMessage,
        });
    }
    catch {
        // silent
    }
}
/**
 * Public entry. P-01 inflight gate:同 rid 并发复用 promise(spec "saveVideo
 * ToMount 同 recordingId 并发中继去重")。
 *
 * 注意:**不能**声明为 `async function`。async 函数每次调用都会创建一个
 * 新的 Promise wrapper,即使内部 `return existing` 也会被包成新 Promise,
 * 导致 `p1 === p2` 失败、调用方无法用 reference identity 验证去重生效。
 * 这里保持普通 function 返回 Promise,让 `return existing` 真正复用引用。
 */
export function relayVideoToMount(input) {
    // H2 (Option A): inflight key = recordingId。relay-state.json 单 recording
    // 单文件,一个 rid 同时中继到多个挂载点会并发写同一文件 last-writer-wins。
    // 同 rid+同 mountPath 并发 → 复用 promise 去重(P-01,保 reference identity,
    // 故本函数保持非 async);同 rid+不同 mountPath 并发 → 拒绝 RELAY_BUSY,
    // 要求等在途 relay 结束再重试(handler 侧已先 peekRelayInflight 拦,此处
    // 为 defense-in-depth)。
    const key = input.recordingId;
    const existing = relayInflight.get(key);
    if (existing) {
        if (existing.mountPath === input.mountPath) {
            existing.keepVideoOnMount = input.keepVideoOnMount;
            return existing.promise;
        }
        return Promise.resolve({
            ok: false,
            errorCode: "RELAY_BUSY",
            errorMessage: `recording ${input.recordingId} is already being relayed to ` +
                `${existing.mountPath}; retry after it finishes`,
        });
    }
    const abortController = new AbortController();
    const promise = relayInner(input, abortController.signal).finally(() => {
        if (relayInflight.get(key)?.promise === promise) {
            relayInflight.delete(key);
        }
    });
    relayInflight.set(key, {
        mountPath: input.mountPath,
        promise,
        abortController,
        keepVideoOnMount: input.keepVideoOnMount,
    });
    return promise;
}
//# sourceMappingURL=relay-task.js.map