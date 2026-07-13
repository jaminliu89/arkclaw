import fs from "node:fs/promises";
import path from "node:path";
import { getRecording, listRecordings, reconcileOnStartup, removeRecording, } from "./recording-state.js";
import { ACTIVE_STATUSES, readSkillsConfig } from "./helpers.js";
import { resolveVtpHome } from "./vtp-paths.js";
import { readRelayState, sweepInterruptedRelays, } from "./mount-relay/relay-state.js";
import { peekRelayInflight } from "./mount-relay/relay-task.js";
import { withCommandSpan } from "./observability/tracer.js";
import { recordHistogram } from "./observability/metrics.js";
import { vtpLog } from "./observability/logger.js";
// 二期 D-20 双域解耦:rebuildCuaRecordingIndex 不再由 cleanup-scheduler
// 触发 — AUTO-INDEX rebuild 是任务模板域职责,迁移到 skill-index-scheduler
// (spec vtp-video-preview "双域解耦修正" / vtp-task-template
// "skill-index-scheduler")。一期此处的 forward import 删除。
// 二期 ADR-0028 (2026-05-21 amended): per-run skill.log 已淘汰 —— runtime /
// plugin 日志统一写 /var/log/openclaw_plugins/vtp/ 滚动文件,采集 / 轮转老化
// 由 OneAgent 等运维工具负责。原 cleanupOldLogs(扫 runs/<rid>/prompt/skill.log
// 并按 recordingRetentionDays unlink)及其 symlink 防护 helper isSafeRecordingDir
// 已一并删除 —— ADR-0028 明令「cleanup-scheduler 不扫 .log 文件」。录制域整
// 目录清理仍由下方 pruneOldRecordings 负责(按 endedAt > recordingRetentionDays)。
const MS_PER_DAY = 86_400_000;
const HOUR_MS = 3_600_000;
// F-8 (review V5): VTP 不可能早于 2020,作 endedAt/createdAt 脏数据 floor
// (低于此 floor 的解析结果回退 dir mtime 防误删)。原先在 pruneOldRecordings
// 函数体内每次 parse 同一字符串,提到模块顶与其他时间常量并列。
const TIMESTAMP_FLOOR_MS = Date.parse("2020-01-01T00:00:00Z");
// 二期 F-B: retention policy 收敛到 configSchema.recordingRetentionDays (默认 7 天)。
// 老分级 (RECORDING_RETENTION_DAYS=7 + PROMPT_DIR_RETENTION_DAYS=30) 被
// pruneOldRecordings 统一为单一 recordingRetentionDays 兜底清。
/**
 * 二期 F-B (spec vtp-video-preview "cleanup-scheduler 清理整个 runs/<rid>/"):
 * 按 endedAt > recordingRetentionDays 清整个 runs/<rid>/ + state.recordings 条目。
 * **scope 严格在录制域** (D-20):reference/<slug>/ 任务模板永不动。
 *
 * endedAt 选取规则:state.recordings[rid].endedAt 优先,缺失时用 meta.json
 * createdAt 兜底 (terminal 终态时间),最后 fallback 到 dir mtime。
 *
 * 返回 { deletedRids, skippedActive, deleteFailed } 用于 audit log。
 * F-3 (review V5): deleteFailed 与 skippedActive 区分 — 前者是 safeRecursiveRm
 * 真删除失败,后者是业务保护(活跃录制 / 在途 relay)主动跳过。监控仪表盘
 * 看 summary log 时一目了然区分"真失败"和"被保护"。
 */
async function pruneOldRecordings(api, vtpHome, stateDir, retentionDays) {
    // #9: readSkillsConfig 已把 recordingRetentionDays 钳到最小 1
    // (configSchema minimum:1),retentionDays 恒 ≥ 1。原 `retentionDays <= 0
    // → 关闭清理` 的逃生分支生产路径永不可达,删除以免留「拧不动的开关」。
    const runsDir = path.join(vtpHome, "runs");
    let entries = [];
    try {
        entries = await fs.readdir(runsDir);
    }
    catch {
        return { deletedRids: [], skippedActive: 0, deleteFailed: 0 };
    }
    // 读 state.recordings 拿活跃 rid 集合 + endedAt 索引
    const stateRecsByRid = new Map();
    try {
        const recs = await listRecordings(stateDir);
        for (const r of recs) {
            stateRecsByRid.set(r.recordingId, {
                endedAt: r.endedAt,
                status: r.status,
            });
        }
    }
    catch {
        // state unavailable → 保守不清,避免错删活跃数据
        return {
            deletedRids: [],
            skippedActive: entries.length,
            deleteFailed: 0,
        };
    }
    // M-2 (review 2026-05-25): active 三态走 helpers.ACTIVE_STATUSES 单一来源,
    // 不再 inline。当状态机增加新 active 状态时,只需改 helpers.ts:154。
    // F-8 (review V5): TIMESTAMP_FLOOR_MS 已提到模块顶,这里直接复用模块常量。
    const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
    const deletedRids = [];
    let skippedActive = 0;
    let deleteFailed = 0;
    for (const rid of entries) {
        const stateEntry = stateRecsByRid.get(rid);
        // 活跃状态的录制永不清 (业务保护)
        if (stateEntry && ACTIVE_STATUSES.has(stateEntry.status)) {
            skippedActive += 1;
            continue;
        }
        const dir = path.join(runsDir, rid);
        try {
            const st = await fs.lstat(dir);
            if (st.isSymbolicLink()) {
                try {
                    await fs.unlink(dir);
                }
                catch {
                    /* ignore */
                }
                continue;
            }
            if (!st.isDirectory())
                continue;
            // endedAt 优先级:state.endedAt > meta.json createdAt > dir mtime
            let effectiveMs = st.mtimeMs;
            if (stateEntry?.endedAt) {
                const t = Date.parse(stateEntry.endedAt);
                if (Number.isFinite(t) && t >= TIMESTAMP_FLOOR_MS)
                    effectiveMs = t;
            }
            else {
                try {
                    const metaRaw = await fs.readFile(path.join(dir, "prompt", "meta.json"), "utf8");
                    const meta = JSON.parse(metaRaw);
                    if (typeof meta.createdAt === "string") {
                        const t = Date.parse(meta.createdAt);
                        if (Number.isFinite(t) && t >= TIMESTAMP_FLOOR_MS)
                            effectiveMs = t;
                    }
                }
                catch {
                    /* keep dir mtime */
                }
            }
            if (effectiveMs >= cutoffMs)
                continue;
            // Double-check: re-read recording state immediately before the
            // destructive rm. Between the snapshot (listRecordings above) and
            // here, a new recording flow could have started writing to this rid —
            // if so, skip to avoid deleting an active directory.
            const fresh = await getRecording(stateDir, rid).catch(() => null);
            if (fresh && ACTIVE_STATUSES.has(fresh.status)) {
                skippedActive += 1;
                continue;
            }
            // #2: relay 是 detached 后台任务,不反映在 recording.status —
            // 一个 succeeded 录制可能正被 relayVideoToMount 中继(写
            // runs/<rid>/relay-state.json + 拷 mp4)。此时 safeRecursiveRm 删
            // runs/<rid>/ 会让 relay 的 writeRelayState / copy 中途 ENOENT。
            // 进程内 inflight gate 命中、或 relay-state status=pending → 跳过
            // 本轮,留待下个 tick(relay 完成后 status=completed,删目录才安全)。
            //
            // I-1 (review 2026-05-25): peekRelayInflight is process-local only;
            // persisted relay-state.json status="pending" is the cross-restart
            // guard. Keep both checks — in-memory map is the fast-path, on-disk
            // state is the correctness boundary across plugin restarts.
            if (peekRelayInflight(rid)) {
                skippedActive += 1;
                continue;
            }
            const relayState = await readRelayState(vtpHome, rid).catch(() => null);
            if (relayState?.status === "pending") {
                skippedActive += 1;
                continue;
            }
            const ageDays = Math.floor((Date.now() - effectiveMs) / MS_PER_DAY);
            // D.2 (review 2026-05-24, #14): bind safeRecursiveRm to the dev/ino
            // pair captured by the lstat above. Between lstat and rm the path
            // could be swapped (TOCTOU); the inode check refuses to delete a
            // different directory than the one we inspected. Same defense as
            // gateway-handlers/delete.ts:87 uses for delete RPC.
            const rmResult = await safeRecursiveRm(dir, {
                expectedRoot: { dev: st.dev, ino: st.ino },
            });
            if (!rmResult.removed && !rmResult.missing) {
                api.logger?.warn?.(`[vtp] pruneOldRecordings: failed to delete ${rid}: ${rmResult.errors.map((e) => `${e.op}:${e.message}`).join("; ")}`);
                // F-3 (review V5): 真删除失败计入 deleteFailed,与"业务保护跳过"
                // (skippedActive) 拆开,dashboard 能直接区分两类。warn 日志仍能定位
                // 具体 rid + op 的真因。
                deleteFailed += 1;
                continue;
            }
            // state.recordings 条目同步删除 (D-20 录制域内部一致性)
            if (stateEntry) {
                await removeRecording(stateDir, rid);
            }
            deletedRids.push(rid);
            api.logger?.info?.(`[vtp] cleanup_action delete_recording rid=${rid} reason=recordingRetentionDays_expired ageDays=${ageDays}`);
        }
        catch (err) {
            api.logger?.warn?.(`[vtp] pruneOldRecordings: skip ${rid}: ${err.message}`);
        }
    }
    return { deletedRids, skippedActive, deleteFailed };
}
function rmError(op, p, err) {
    const e = err;
    return {
        op,
        path: p,
        message: e instanceof Error ? e.message : String(err),
        ...(typeof e.code === "string" ? { code: e.code } : {}),
    };
}
export async function safeRecursiveRm(dir, optsOrDepth = {}) {
    const opts = typeof optsOrDepth === "number" ? { depth: optsOrDepth } : optsOrDepth;
    const depth = opts.depth ?? 0;
    const errors = [];
    // R-Round-N M11: depth guard against pathological deeply-nested trees.
    // Without this, an attacker (or even a buggy producer) creating 10k+
    // levels would blow the call stack via the recursive descent below at
    // `await safeRecursiveRm(full, depth + 1)`. 64 is well above any plausible
    // legitimate workspace skill layout while still safely below default
    // Node stack budget.
    if (depth > 64) {
        throw new Error(`safeRecursiveRm: depth limit 64 exceeded at ${dir}`);
    }
    try {
        const root = await fs.lstat(dir);
        if (root.isSymbolicLink()) {
            await fs.unlink(dir);
            return { removed: true, missing: false, errors };
        }
        if (opts.expectedRoot) {
            if (!root.isDirectory() ||
                root.dev !== opts.expectedRoot.dev ||
                root.ino !== opts.expectedRoot.ino) {
                errors.push({
                    op: "lstat",
                    path: dir,
                    message: "root identity changed before recursive removal",
                });
                return { removed: false, missing: false, errors };
            }
        }
        if (!root.isDirectory()) {
            await fs.unlink(dir);
            return { removed: true, missing: false, errors };
        }
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { removed: false, missing: true, errors };
        }
        errors.push(rmError("lstat", dir, err));
        return { removed: false, missing: false, errors };
    }
    let entries = [];
    // R8 M2: distinguish "readdir failed (EACCES/ENOENT/...)" from "dir is
    // empty". On readdir failure, skip the recursive walk + just attempt the
    // dir entry itself — recursing into an unreadable subtree and then trying
    // rmdir on its parent generates noisy ENOTEMPTY catches in logs. Empty
    // dirs still hit the rmdir-only path below.
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { removed: false, missing: true, errors };
        }
        errors.push(rmError("readdir", dir, err));
        try {
            await fs.rmdir(dir);
            return { removed: true, missing: false, errors };
        }
        catch (rmdirErr) {
            errors.push(rmError("rmdir", dir, rmdirErr));
            return { removed: false, missing: false, errors };
        }
    }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        try {
            // Re-lstat to double-check (Dirent.isSymbolicLink may not survive on
            // all platforms / FS types; lstat is the authoritative source).
            const st = await fs.lstat(full);
            if (st.isSymbolicLink()) {
                try {
                    await fs.unlink(full);
                }
                catch (err) {
                    errors.push(rmError("unlink", full, err));
                }
            }
            else if (st.isDirectory()) {
                // R-Round-N M1: TOCTOU symlink-swap mitigation. Between this lstat
                // and the recursive descent below, an attacker with write access to
                // the cleanup root could swap `full` from a real directory to a
                // symlink pointing at /etc — readdir inside safeRecursiveRm would
                // then follow the symlink and unlink files outside the cleanup
                // root. Re-stat right before recursion and refuse to descend if
                // dev/inode/symlink-status changed.
                let safe = true;
                try {
                    const verify = await fs.lstat(full);
                    if (verify.isSymbolicLink() ||
                        !verify.isDirectory() ||
                        verify.dev !== st.dev ||
                        verify.ino !== st.ino) {
                        safe = false;
                    }
                }
                catch {
                    safe = false;
                }
                if (!safe) {
                    // Suspicious swap detected — unlink (if it became a symlink) but
                    // do NOT recurse. Best-effort: may ENOTEMPTY if it stayed a dir.
                    try {
                        await fs.unlink(full);
                    }
                    catch (err) {
                        errors.push(rmError("unlink", full, err));
                    }
                    continue;
                }
                const child = await safeRecursiveRm(full, { depth: depth + 1 });
                errors.push(...child.errors);
            }
            else {
                try {
                    await fs.unlink(full);
                }
                catch (err) {
                    errors.push(rmError("unlink", full, err));
                }
            }
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                errors.push(rmError("lstat", full, err));
            }
        }
    }
    try {
        await fs.rmdir(dir);
    }
    catch (err) {
        // dir not empty / permission denied — leave it; periodic sweep will
        // retry.
        if (err.code === "ENOENT") {
            return { removed: false, missing: true, errors };
        }
        errors.push(rmError("rmdir", dir, err));
        return { removed: false, missing: false, errors };
    }
    return { removed: errors.length === 0, missing: false, errors };
}
/**
 * Run one full maintenance pass. All tasks are independent
 * (Promise.allSettled) so one failure does not block the others. Failures
 * never throw; callers fire-and-forget with .catch().
 * Returns aggregate deleted counts for observability (scheduler tick metrics).
 */
async function runAllMaintenance(ctx) {
    const started = Date.now();
    const tasks = [
        // 二期 F-B (spec vtp-video-preview "cleanup-scheduler 清理整个 runs/<rid>/"):
        // 合并一期 pruneOldRecordingVideos + pruneOldPromptDirs 为 pruneOldRecordings,
        // 按 endedAt > recordingRetentionDays 清整个 runs/<rid>/ + state.recordings 条目。
        // 任务模板 reference/<slug>/ 永不动 (D-20 双域解耦)。
        // ADR-0028: 原 cleanupOldLogs(.log 扫描)task 已删 —— skill.log 淘汰。
        pruneOldRecordings(ctx.api, ctx.vtpHome, ctx.stateDir, ctx.recordingRetentionDays).then((r) => ({ recordings: r })),
        // 二期 D-20 双域解耦:AUTO-INDEX rebuild 迁移到 skill-index-scheduler。
    ];
    // Reconcile only at startup — running every hour would be wasteful and
    // could race with in-flight RPC handlers that are patching the same state.
    if (ctx.reconcileOnce) {
        tasks.push(reconcileOnStartup(ctx.stateDir).then((r) => ({ reconcile: r })));
    }
    const results = await Promise.allSettled(tasks);
    const summary = {
        at: new Date().toISOString(),
        tookMs: Date.now() - started,
        startup: ctx.reconcileOnce,
    };
    // R10 W-③: collect ALL task errors, not just the last one — Promise
    // .allSettled returns parallel results so multiple tasks can reject in the
    // same sweep (e.g. transient EBUSY across logs+videos). Single `error`
    // field would silently drop earlier failures, hiding correlated faults.
    const errors = [];
    for (const r of results) {
        // R9 N-Ⓐ: Object.assign flattens each task's {key:value} into summary.
        // Safe by construction because each task uses a distinct key
        // (`recordings` / `reconcile`); two tasks with the same key would
        // silently overwrite. Add a new task → pick a new key.
        if (r.status === "fulfilled")
            Object.assign(summary, r.value);
        else
            errors.push(String(r.reason));
    }
    if (errors.length > 0)
        summary.errors = errors;
    ctx.api.logger?.info?.(`[vtp:maint] ${JSON.stringify(summary)}`);
    // Extract counts for caller (scheduler tick observability).
    const recsResult = results[0];
    const deletedRids = recsResult?.status === "fulfilled" &&
        Array.isArray(recsResult.value
            ?.recordings?.deletedRids)
        ? (recsResult.value.recordings.deletedRids.length ?? 0)
        : 0;
    return { deletedRids };
}
/**
 * Install startup + periodic maintenance.
 *   - startup sweep: fire-and-forget once (reconcile + full cleanup pass)
 *   - periodic sweep: every 1h via setInterval().unref() so the timer never
 *     prevents Node.js from exiting when the plugin is torn down
 *
 * Returns a teardown function for tests; production callers fire-and-forget.
 */
export function startMaintenanceScheduler(api) {
    const stateDir = api.runtime.state.resolveStateDir();
    const vtpHome = resolveVtpHome(api);
    // R-review-fix M4: re-read skillsCfg on every maintenance pass so live
    // config edits (recordingRetentionDays / vtpRecordingRoot) take effect at the
    // next 1h tick instead of requiring plugin restart. Mirrors pluginConfig()
    // / readSkillsConfig() callers elsewhere that always read fresh.
    const buildCtx = (isStartup) => {
        const skillsCfg = readSkillsConfig(api);
        return {
            api,
            stateDir,
            vtpHome,
            recordingRetentionDays: skillsCfg.recordingRetentionDays,
            reconcileOnce: isStartup,
        };
    };
    // M-1: 启动首扫与周期扫描(下方 command.cleanup / "scheduler")一样进
    // withCommandSpan —— 清理量最大的这次不应在 trace 里隐身;trigger 标
    // "startup" 与周期 "scheduler" 区分。
    void withCommandSpan("command.cleanup", "scheduler", { "cleanup.phase": "startup" }, async () => {
        await runAllMaintenance(buildCtx(true));
    }).catch((err) => {
        api.logger?.warn?.(`[vtp:maint] startup sweep failed: ${String(err)}`);
    });
    // H1: relay 启动自愈 —— plugin 重启会中断 in-flight 中继,残留的
    // relay-state.json status="pending" 若不复位,前端 videoRelayStatus 永远
    // 卡在 pending(ADR-0025「启动扫描 pending → failed」)。此前
    // sweepInterruptedRelays 只有定义 + 测试、无生产调用点 —— 在此接线。
    // fire-and-forget,失败不阻塞 plugin 启动。
    void sweepInterruptedRelays(vtpHome)
        .then((r) => {
        if (r.swept > 0) {
            vtpLog.info(undefined, {
                event: "relay_startup_sweep",
                sweptCount: r.swept,
            });
        }
    })
        .catch((err) => {
        api.logger?.warn?.(`[vtp:maint] relay startup sweep failed: ${String(err)}`);
    });
    const timer = setInterval(() => {
        const tickStart = Date.now();
        void withCommandSpan("command.cleanup", "scheduler", {}, async () => {
            const counts = await runAllMaintenance(buildCtx(false));
            const durationMs = Date.now() - tickStart;
            const deletedCount = counts.deletedRids;
            try {
                recordHistogram("vtp.cleanup.unlinked_count", deletedCount, {});
            }
            catch {
                // silent — metrics must not break tick
            }
            vtpLog.info(undefined, {
                event: "scheduler_tick",
                scheduler: "cleanup",
                result: "success",
                durationMs,
                deletedRids: deletedCount,
            });
            return counts;
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
                scheduler: "cleanup",
                result: "error",
                durationMs,
                errorCode,
            });
            api.logger?.warn?.(`[vtp:maint] periodic sweep failed: ${String(err)}`);
        });
    }, HOUR_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}
//# sourceMappingURL=cleanup-scheduler.js.map