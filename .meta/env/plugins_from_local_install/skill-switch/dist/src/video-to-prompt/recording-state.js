import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
// coco H1: readRelayFieldsForView 复用 gated reader,见下方注释。
// relay-state.ts 只 import ../types.js,无回指 recording-state 的循环。
import { readRelayState } from "./mount-relay/relay-state.js";
// R11 P2-①: single source of truth for "active / non-terminal" recording
// statuses. helpers.ts owns ACTIVE_STATUSES (R10 Critical-① consolidation);
// importing it here removes the local NON_TERMINAL_STATUSES duplicate that
// would silently drift if a 4th active status (e.g. "uploading") were added
// later. Circular import is safe — both sides only access the binding inside
// function bodies, never at module load.
// R-Santa W8: also import shared atomicWriteFileWithSync (was previously
// inlined inside writeState) so all 4 prior copies converge on one source.
import { ACTIVE_STATUSES, atomicWriteFileWithSync } from "./helpers.js";
const STATE_REL_PATH = ["extensions", "video-to-prompt", "state.json"];
// File-lock tunables. Concurrent gateway calls (e.g. simultaneous stop +
// analyze) would otherwise race read-modify-write and lose state. The lock is
// acquired only around mutations; reads stay lock-free because writeState uses
// tmp+rename for atomic publish.
const LOCK_RETRY_INTERVAL_MS = 50;
// Acquire timeout MUST exceed LOCK_STALE_AFTER_MS so that a waiter has a
// chance to witness a crashed holder's lock become stale and reclaim it.
// Previously 5s < 10s meant every contended acquire hit the timeout before
// the stale-clean path ever ran.
const LOCK_STALE_AFTER_MS = 10_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
function resolveStatePath(stateDir) {
    return path.join(stateDir, ...STATE_REL_PATH);
}
function resolveLockPath(stateDir) {
    return resolveStatePath(stateDir) + ".lock";
}
function emptyState() {
    return { version: 1, activeRecordingId: null, recordings: {} };
}
async function readState(stateDir) {
    const statePath = resolveStatePath(stateDir);
    // R-Round-N H2: fail-closed on non-ENOENT errors. Old catch-all swallowed
    // EVERYTHING — corrupted JSON, EACCES, EIO — and silently returned
    // emptyState. The next writeState would then OVERWRITE the (recoverable)
    // corrupt file with empty state, destroying all historical recordings
    // irreversibly. Now ENOENT is the only "treat as empty" signal; any other
    // error throws so caller's withStateLock + plugin logger surface it.
    let raw;
    try {
        raw = await fs.readFile(statePath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return emptyState();
        }
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new Error(`state.json corrupt at ${statePath}: ${err.message}. Refusing to overwrite — manual recovery required.`);
    }
    if (parsed &&
        parsed.version === 1 &&
        typeof parsed.recordings === "object" &&
        parsed.recordings) {
        return parsed;
    }
    throw new Error(`state.json schema mismatch at ${statePath}: version=${parsed?.version}. Refusing to overwrite.`);
}
async function writeState(stateDir, state) {
    const statePath = resolveStatePath(stateDir);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    // R8 Warn-① / R-Santa W8: state.json is the recording-metadata SoT — fsync
    // the data file BEFORE rename so power-loss/SIGKILL between write and
    // rename can't leave a renamed-but-empty target. Shared helper from
    // helpers.ts handles open / writeFile / fsync / close / rename + tmp
    // cleanup on failure (R7 H7 pattern).
    await atomicWriteFileWithSync(statePath, JSON.stringify(state, null, 2));
}
async function acquireStateLock(stateDir) {
    const lockPath = resolveLockPath(stateDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const start = Date.now();
    while (true) {
        // I4: enforce overall acquire timeout on EVERY loop iteration, not just
        // the EEXIST → stale-clean → continue branch. The verify-mismatch /
        // read-failure `continue` paths above used to skip this check, so a
        // pathologically contended state.json could loop forever. Hoisting the
        // deadline check to the top makes it apply to all retry paths uniformly.
        if (Date.now() - start > LOCK_ACQUIRE_TIMEOUT_MS) {
            throw new Error(`recording-state: lock acquire timeout after ${LOCK_ACQUIRE_TIMEOUT_MS}ms (${lockPath})`);
        }
        const nonce = randomBytes(12).toString("hex");
        try {
            const fh = await fs.open(lockPath, "wx");
            await fh.write(`pid=${process.pid}\nnonce=${nonce}\nacquired=${new Date().toISOString()}\n`);
            // R-Coco M2: fsync the lock contents so a crash between write and the
            // post-acquire verify won't leave an empty lock that forces the next
            // acquirer to wait LOCK_STALE_AFTER_MS (10s) for stale-clean. Do NOT
            // route this through helpers.atomicWriteFileWithSync — that helper
            // uses tmp+rename which would defeat the `wx` (exclusive create)
            // semantics this lock protocol depends on.
            await fh.sync();
            // R6 H10: post-acquire nonce-recheck. With wx-open the kernel guarantees
            // exclusive create, so this is belt-and-suspenders against any future
            // refactor that downgrades the open mode and against the stale-clean →
            // re-acquire race window where two waiters could both classify the
            // same lock as stale and unlink it.
            try {
                const verify = await fs.readFile(lockPath, "utf8");
                // R8 N1: regex with line anchors instead of substring includes — a
                // crafted file content with `nonce=<our-hex>` embedded in another
                // field's value (theoretical) would otherwise pass. word-boundary
                // is enough since nonce is hex and the prefix `nonce=` only legally
                // appears once per line.
                if (!new RegExp(`^nonce=${nonce}$`, "m").test(verify)) {
                    await fh.close().catch(() => { });
                    // R-Round-N M7-soft: unlink the half-written / mismatched lock
                    // immediately so the next acquirer doesn't have to wait
                    // LOCK_STALE_AFTER_MS (10s) for stale-clean. wx-open above
                    // guarantees we won this race; the verify mismatch means a
                    // concurrent acquirer raced past us and our nonce is no longer
                    // authoritative. Best-effort unlink: if unlink loses the race,
                    // stale-clean still recovers eventually.
                    await fs.unlink(lockPath).catch(() => { });
                    await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
                    continue;
                }
            }
            catch {
                await fh.close().catch(() => { });
                // R-Round-N M7-soft: same as above — clean up the half-written lock
                // we created, otherwise next acquirer waits LOCK_STALE_AFTER_MS.
                await fs.unlink(lockPath).catch(() => { });
                continue;
            }
            return { fh, nonce };
        }
        catch (err) {
            const code = err.code;
            if (code !== "EEXIST")
                throw err;
            // Force-clear stale lock (e.g. previous process crashed).
            // R6 H2: lstat (not stat) to avoid following a symlink — an attacker
            // who can drop a symlink at lockPath could otherwise make this branch
            // mtime-check the wrong file. wx-open above already guarantees data
            // safety; this is defense-in-depth.
            try {
                const lst = await fs.lstat(lockPath);
                if (Date.now() - lst.mtimeMs > LOCK_STALE_AFTER_MS) {
                    await fs.unlink(lockPath).catch(() => { });
                    continue;
                }
            }
            catch {
                // Lock disappeared between EEXIST and lstat — retry immediately.
                continue;
            }
            // I4: deadline check is hoisted to top of while(true) — no need to
            // re-check here. Sleep then retry; next iteration's check enforces.
            await new Promise((r) => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
        }
    }
}
async function releaseStateLock(stateDir, handle) {
    const lockPath = resolveLockPath(stateDir);
    await handle.fh.close().catch(() => { });
    // C1: only unlink if the file still carries our nonce. If a concurrent
    // waiter already classified our lock as stale and replaced it, the on-disk
    // content will have a different nonce — leave that lock alone.
    // R10 W-②: anchored regex (line-bound) symmetric with acquireStateLock R8 N1
    // — substring `includes` would match a nonce hex value embedded in another
    // line's value (theoretical), risking deletion of a waiter's freshly-acquired
    // lock.
    try {
        const raw = await fs.readFile(lockPath, "utf8");
        if (new RegExp(`^nonce=${handle.nonce}$`, "m").test(raw)) {
            // R11 P3-③: surface unlink failures via stderr. Silent .catch(() => {})
            // would leave the lock present until the 10s staleness timer expired,
            // making 200+ contending acquirers wait pointlessly with no signal as
            // to why. Permission/disk errors here are rare but should be observable.
            await fs.unlink(lockPath).catch((err) => {
                const msg = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[recording-state] releaseStateLock unlink failed (${lockPath}): ${msg}\n`);
            });
        }
    }
    catch {
        // Lock already gone → nothing to do.
    }
}
async function withStateLock(stateDir, fn) {
    const handle = await acquireStateLock(stateDir);
    try {
        return await fn();
    }
    finally {
        await releaseStateLock(stateDir, handle);
    }
}
export async function getActiveRecording(stateDir) {
    const state = await readState(stateDir);
    if (!state.activeRecordingId)
        return null;
    return state.recordings[state.activeRecordingId] ?? null;
}
export async function getRecording(stateDir, recordingId) {
    const state = await readState(stateDir);
    return state.recordings[recordingId] ?? null;
}
export async function listRecordings(stateDir) {
    const state = await readState(stateDir);
    return Object.values(state.recordings).sort((a, b) => {
        return b.startedAt.localeCompare(a.startedAt);
    });
}
export async function pickDefaultRecording(stateDir, intent) {
    const all = await listRecordings(stateDir);
    switch (intent) {
        case "latest-stopped":
            return all.find((r) => r.status === "stopped") ?? null;
        case "resumable-stopped": {
            for (const r of all) {
                if (r.status !== "stopped" || !r.videoPath)
                    continue;
                try {
                    const st = await fs.stat(r.videoPath);
                    if (st.isFile())
                        return r;
                }
                catch {
                    // file missing → keep scanning
                }
            }
            return null;
        }
        case "latest-completed":
            return (all.find((r) => r.status === "stopped" ||
                r.status === "succeeded" ||
                r.status === "failed") ?? null);
        case "in-flight-task": {
            for (const r of all) {
                if (r.status === "recording" ||
                    r.status === "paused" ||
                    r.status === "analyzing") {
                    return r;
                }
                if (r.status === "stopped" && r.videoPath) {
                    try {
                        const st = await fs.stat(r.videoPath);
                        if (st.isFile())
                            return r;
                    }
                    catch {
                        // video gone → treat as archived, keep scanning
                    }
                }
            }
            return null;
        }
    }
}
export async function upsertRecording(stateDir, recording, opts) {
    await withStateLock(stateDir, async () => {
        const state = await readState(stateDir);
        state.recordings[recording.recordingId] = recording;
        if (opts?.setActive) {
            state.activeRecordingId = recording.recordingId;
        }
        await writeState(stateDir, state);
    });
}
export async function patchRecording(stateDir, recordingId, patch) {
    return withStateLock(stateDir, async () => {
        const state = await readState(stateDir);
        const current = state.recordings[recordingId];
        if (!current)
            return null;
        // R6 H9: explicit "clear field" semantics. Plain spread leaves
        // patch.error: undefined as "merged.error = undefined" which JSON.stringify
        // drops anyway, but the contract of "set this key to undefined to clear
        // it" is fragile (any future required field would silently coerce). Walk
        // patch keys explicitly: undefined → delete, defined → assign.
        const merged = { ...current };
        const mergedAny = merged;
        for (const key of Object.keys(patch)) {
            const v = patch[key];
            if (v === undefined) {
                delete mergedAny[key];
            }
            else {
                mergedAny[key] = v;
            }
        }
        state.recordings[recordingId] = merged;
        await writeState(stateDir, state);
        return merged;
    });
}
export async function patchRecordingIfStatus(stateDir, recordingId, expectedStatuses, patch) {
    return withStateLock(stateDir, async () => {
        const state = await readState(stateDir);
        const current = state.recordings[recordingId];
        if (!current)
            return null;
        if (!expectedStatuses.includes(current.status))
            return null;
        const merged = { ...current };
        const mergedAny = merged;
        for (const key of Object.keys(patch)) {
            const v = patch[key];
            if (v === undefined) {
                delete mergedAny[key];
            }
            else {
                mergedAny[key] = v;
            }
        }
        state.recordings[recordingId] = merged;
        await writeState(stateDir, state);
        return merged;
    });
}
export async function clearActiveRecording(stateDir) {
    await withStateLock(stateDir, async () => {
        const state = await readState(stateDir);
        state.activeRecordingId = null;
        await writeState(stateDir, state);
    });
}
/**
 * 二期 F-B (D-20 双域解耦):删除 state.recordings 条目。
 * delete RPC 方案 B + cleanup-scheduler 扩范围 共用。原子写,清 activeRecordingId
 * 若指向被删 rid。任务模板域 reference/<slug>/ 不动 (调用方负责)。
 */
export async function removeRecording(stateDir, recordingId) {
    return withStateLock(stateDir, async () => {
        const state = await readState(stateDir);
        if (!(recordingId in state.recordings))
            return false;
        delete state.recordings[recordingId];
        if (state.activeRecordingId === recordingId) {
            state.activeRecordingId = null;
        }
        await writeState(stateDir, state);
        return true;
    });
}
export function generateRecordingId() {
    const ts = Math.floor(Date.now() / 1000);
    // crypto.randomBytes replaces Math.random — recordingId crosses permission
    // boundaries (delete / saveAsSkill / renderInstruction all dispatch by id).
    // 6 bytes = 48 bits = 2.8 × 10^14 distinct values, enough to make brute-force
    // probing infeasible. Format `rec_<unix-seconds>_<12-hex>` keeps the
    // chronological prefix so operators can still eyeball timestamps from a
    // recordingId.
    const rand = randomBytes(6).toString("hex");
    return `rec_${ts}_${rand}`;
}
export function isProcessAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
// R11 P2-①: NON_TERMINAL_STATUSES removed — replaced by ACTIVE_STATUSES from
// helpers.js (single source of truth). The set semantically maps the same
// three states (recording / paused / analyzing) but lives in one place so a
// future addition (e.g. "uploading") cannot diverge across files.
const PROMPT_PREVIEW_CHARS = 200;
async function readPromptArtifact(promptDir) {
    if (!promptDir)
        return null;
    try {
        const promptPath = path.join(promptDir, "prompt.json");
        const raw = await fs.readFile(promptPath, "utf8");
        const parsed = JSON.parse(raw);
        const taskName = typeof parsed.taskName === "string" && parsed.taskName.trim().length > 0
            ? parsed.taskName
            : undefined;
        let promptText;
        for (const key of ["prompt", "text", "instruction"]) {
            const v = parsed[key];
            if (typeof v === "string" && v.trim().length > 0) {
                promptText = v;
                break;
            }
        }
        let preview;
        if (promptText) {
            preview =
                promptText.length > PROMPT_PREVIEW_CHARS
                    ? `${promptText.slice(0, PROMPT_PREVIEW_CHARS)}…`
                    : promptText;
        }
        // F3: confidence is best-effort. PromptArtifact declares it as optional
        // number; reject NaN / out-of-range values defensively so a corrupt
        // prompt.json can't surface "confidence: 1.5" in the UI.
        let confidence;
        if (typeof parsed.confidence === "number" &&
            Number.isFinite(parsed.confidence)) {
            const c = parsed.confidence;
            if (c >= 0 && c <= 1)
                confidence = c;
        }
        return { taskName, preview, confidence };
    }
    catch {
        return null;
    }
}
/**
 * Best-effort startup reconciliation. Plugin watchdogs (scheduleAutoStop,
 * skill exit listener) live in process memory and vanish on host restart,
 * leaving any non-terminal recording stuck. We scan all recordings and patch
 * the ones whose owning process is no longer alive:
 *   - recording / paused → ffmpeg dead → stopped + error
 *   - analyzing          → skill dead  → failed  + error
 * Active recording is cleared if the active recording itself is dead.
 *
 * Failures inside this function MUST NOT block plugin startup; callers
 * should fire-and-forget with .catch().
 */
// In-process mutex for reconcile. Without this, two fire-and-forget callers
// (e.g. plugin.register() startup + the first setInterval tick racing before
// startup completes) could each scan the same non-terminal entries and
// produce conflicting patches. The advisory file lock guards each patch
// individually but not the orchestration across patches.
let reconcileInProgress = false;
export async function reconcileOnStartup(stateDir) {
    if (reconcileInProgress)
        return { patched: 0 };
    reconcileInProgress = true;
    try {
        return await reconcileOnStartupInner(stateDir);
    }
    finally {
        reconcileInProgress = false;
    }
}
async function reconcileOnStartupInner(stateDir) {
    const state = await readState(stateDir);
    let patched = 0;
    for (const rec of Object.values(state.recordings)) {
        if (!ACTIVE_STATUSES.has(rec.status))
            continue;
        const isRecordingPhase = rec.status === "recording" || rec.status === "paused";
        const isAnalyzingPhase = rec.status === "analyzing";
        const ownerPid = isRecordingPhase ? rec.ffmpegPid : rec.skillPid;
        if (isProcessAlive(ownerPid))
            continue;
        if (isAnalyzingPhase) {
            const terminalMeta = await readTerminalMeta(rec.promptDir);
            if (terminalMeta) {
                const metaPatch = {
                    status: terminalMeta.status,
                    endedAt: rec.endedAt ?? new Date().toISOString(),
                };
                if (terminalMeta.error)
                    metaPatch.error = terminalMeta.error;
                const updated = await patchRecordingIfStatus(stateDir, rec.recordingId, [rec.status], metaPatch);
                if (updated) {
                    const fresh = await readState(stateDir);
                    if (fresh.activeRecordingId === rec.recordingId) {
                        await clearActiveRecording(stateDir);
                    }
                    patched += 1;
                }
                continue;
            }
        }
        const terminalStatus = isRecordingPhase
            ? "stopped"
            : "failed";
        const reason = isRecordingPhase
            ? "host restarted while recording; ffmpeg process lost"
            : isAnalyzingPhase
                ? "host restarted while analyzing; skill process lost"
                : "host restarted; owning process lost";
        // CAS on snapshot status: if a concurrent RPC (cancel / result-derive /
        // watchdog) already moved this recording out of rec.status, respect
        // that converged terminal state and skip — do not overwrite.
        const updated = await patchRecordingIfStatus(stateDir, rec.recordingId, [rec.status], {
            status: terminalStatus,
            endedAt: rec.endedAt ?? new Date().toISOString(),
            error: rec.error ?? reason,
        });
        if (!updated)
            continue;
        // R-review-fix H3: don't trust the top-of-loop snapshot for
        // activeRecordingId — reconcile sweep is fire-and-forget at plugin
        // startup, so a concurrent handleStart RPC can repoint activeRecordingId
        // to a newly-spawned recording during our patch loop. Re-read fresh
        // state and only clear when it still references the rec we just patched
        // to terminal. Worst case: a brief window where active points at a
        // (now-terminal) rec; the next sweep tick reclaims it.
        const fresh = await readState(stateDir);
        if (fresh.activeRecordingId === rec.recordingId) {
            await clearActiveRecording(stateDir);
        }
        patched += 1;
    }
    return { patched };
}
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
export async function buildRecordingView(stateDir, recordingId, vtpHome) {
    const rec = await getRecording(stateDir, recordingId);
    if (!rec)
        return null;
    let videoExists = false;
    let sizeBytes = rec.sizeBytes ?? null;
    if (rec.videoPath) {
        try {
            const stat = await fs.stat(rec.videoPath);
            if (stat.isFile()) {
                videoExists = true;
                sizeBytes = stat.size;
            }
        }
        catch {
            videoExists = false;
        }
    }
    const format = rec.videoPath
        ? path.extname(rec.videoPath).replace(/^\./, "").toLowerCase() || "mp4"
        : null;
    const promptArtifact = await readPromptArtifact(rec.promptDir);
    const taskName = rec.taskName ?? promptArtifact?.taskName ?? null;
    const promptPreview = promptArtifact?.preview ?? null;
    // F3 (Figma 设计稿"置信度 92%"): surface confidence at view level.
    // null preserves the contract that pre-analyze recordings have no score.
    const confidence = typeof promptArtifact?.confidence === "number"
        ? promptArtifact.confidence
        : null;
    // 二期 F-A: 读 relay-state.json 填充视频中继字段。vtpHome 缺省时
    // (例如老 callsite 未传) 全部 null,RecordingView 兜底为 not_enabled —
    // spec "老录制无 relay-state.json → videoRelayStatus=not_enabled"。
    const relayFields = await readRelayFieldsForView(vtpHome, rec.recordingId);
    // 二期 UX 增强: phaseDetail 派生 + promptError object 化(录制域)。
    // phaseDetail: 读 phase-state.json 找当前 running / 最后 completed phase,
    //   暴露给前端直接渲染进度条,避免前端必须调 events RPC。
    // promptError: 把单字符串 error 包装成 {code, message} 结构,前端可分类
    //   决定"重试"按钮文案/行为。code 当前统一 "ANALYZE_ERROR",后续可按
    //   错误源细分(LLM_TIMEOUT / NETWORK / OOM 等)。
    const phaseDetail = await derivePhaseDetailForView(rec.promptDir ?? null);
    const promptError = rec.error
        ? { code: "ANALYZE_ERROR", message: rec.error }
        : null;
    return {
        recordingId: rec.recordingId,
        status: rec.status,
        startedAt: rec.startedAt ?? null,
        endedAt: rec.endedAt ?? null,
        durationSec: rec.durationSec ?? null,
        sizeBytes,
        resolution: rec.resolution ?? null,
        format,
        videoPath: rec.videoPath ?? null,
        videoExists,
        promptDir: rec.promptDir ?? null,
        taskName,
        promptPreview,
        confidence,
        savedSkills: rec.savedSkills ?? [],
        invocations: null,
        source: "state",
        ffmpegAlive: isProcessAlive(rec.ffmpegPid),
        skillAlive: isProcessAlive(rec.skillPid),
        error: rec.error ?? null,
        ...relayFields,
        phaseDetail,
        promptError,
    };
}
// 二期 UX 增强: 把 phase-state.json 当前活跃 phase + 总进度派生成
// RecordingView.phaseDetail。缺文件 (老 binary / 未 analyze) → null。
async function derivePhaseDetailForView(promptDir) {
    if (!promptDir)
        return null;
    try {
        const { readPhaseStateFile, PHASE_ORDER, PHASE_WEIGHTS } = await import("./phase-progress.js");
        const file = await readPhaseStateFile(promptDir);
        if (!file)
            return null;
        // 找当前 running 的 phase,无则取最后一个 completed,都没有取第一个 pending
        let activeIdx = -1;
        for (let i = 0; i < PHASE_ORDER.length; i++) {
            const p = PHASE_ORDER[i];
            if (p === undefined)
                continue;
            const st = file.phaseProgress[p];
            if (st?.status === "running") {
                activeIdx = i;
                break;
            }
        }
        if (activeIdx < 0) {
            // 取最后一个 completed,否则首个 pending
            for (let i = PHASE_ORDER.length - 1; i >= 0; i--) {
                const p = PHASE_ORDER[i];
                if (p === undefined)
                    continue;
                if (file.phaseProgress[p]?.status === "completed") {
                    activeIdx = i;
                    break;
                }
            }
            if (activeIdx < 0)
                activeIdx = 0;
        }
        const activePhase = PHASE_ORDER[activeIdx];
        if (activePhase === undefined)
            return null;
        const phaseProgress = file.phaseProgress[activePhase]?.percent ?? 0;
        // 二期 ADR-0026: 权重 average (3/20/60/12/5),不再 equal-weighted。
        // REASONING 占 60% 主导,反映真实工作量分布。
        const totalWeight = Object.values(PHASE_WEIGHTS).reduce((a, b) => a + b, 0);
        let weighted = 0;
        for (const p of PHASE_ORDER) {
            const pct = file.phaseProgress[p]?.percent ?? 0;
            weighted += pct * (PHASE_WEIGHTS[p] ?? 0);
        }
        const totalProgressPct = Math.round(weighted / totalWeight);
        return { phase: activePhase, phaseProgress, totalProgressPct };
    }
    catch {
        return null;
    }
}
// 二期 F-A: 单独读 relay-state.json 派生 RecordingView 中继字段。
// vtpHome 缺省 → 全 null (老 callsite 兼容)。任何 IO/解析错误降级为兜底 not_enabled
// (spec Scenario "老录制无 relay-state.json" + "pending 中的视图" + "failed 录制的视图")。
export async function readRelayFieldsForView(vtpHome, recordingId) {
    const fallback = {
        videoRelayStatus: "not_enabled",
        videoMountRelativePath: null,
        videoMountFullPath: null,
        videoRelayError: null,
        keepVideoOnMount: false,
        videoRelayProgress: null,
    };
    if (!vtpHome)
        return fallback;
    try {
        // coco H1: 复用 readRelayState —— 它经 assertSafeRunDir gate(拒
        // runs/<rid> symlink + 非法 rid),此前这里直接 fs.readFile 会跟随
        // runs/<rid> symlink。统一走 gated reader,与同模块 readRelayState
        // 一致、符合 ADR-0018。unsafe / 缺失时 readRelayState 返回 init 兜底
        // → 落下方 init 分支 → fallback。
        const parsed = await readRelayState(vtpHome, recordingId);
        // #10: evicted = 用户取消长期保存,挂载 mp4 已删、不可再保存。视图
        // 降级为 not_enabled(无回放),不暴露已 stale 的 completed + 路径。
        if (parsed.evicted)
            return fallback;
        const status = parsed.status;
        const keep = Boolean(parsed.keepVideoOnMount);
        if (status === "completed") {
            return {
                videoRelayStatus: "completed",
                videoMountRelativePath: parsed.mountRelativePath ?? null,
                videoMountFullPath: parsed.mountAbsolutePath ?? null,
                videoRelayError: null,
                keepVideoOnMount: keep,
                videoRelayProgress: null,
            };
        }
        if (status === "pending") {
            return {
                videoRelayStatus: "pending",
                videoMountRelativePath: null,
                videoMountFullPath: null,
                videoRelayError: null,
                keepVideoOnMount: keep,
                videoRelayProgress: typeof parsed.progress === "number" &&
                    parsed.progress >= 0 &&
                    parsed.progress <= 100
                    ? parsed.progress
                    : 0,
            };
        }
        if (status === "failed") {
            return {
                videoRelayStatus: "failed",
                videoMountRelativePath: null,
                videoMountFullPath: null,
                videoRelayError: {
                    code: parsed.errorCode ?? "UNKNOWN",
                    message: parsed.errorMessage ?? "relay failed",
                },
                keepVideoOnMount: keep,
                videoRelayProgress: null,
            };
        }
        // status === "init" 或未知:回兜底但保留 keepVideoOnMount(start 时可能预设)
        return { ...fallback, keepVideoOnMount: keep };
    }
    catch {
        return fallback;
    }
}
// ────────────────────────────────────────────────────────────────────────────
// Shared recording-view helpers — status derivation + on-disk reference
// entry conversion. Moved here from gateway.ts private scope.
// ────────────────────────────────────────────────────────────────────────────
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
export async function deriveStatusFromMetaTransition(stateDir, target) {
    if (target.status !== "analyzing" && target.status !== "stopped") {
        return { recording: target, transitioned: false };
    }
    const terminalMeta = await readTerminalMeta(target.promptDir);
    if (!terminalMeta)
        return { recording: target, transitioned: false };
    const patch = {
        status: terminalMeta.status,
        endedAt: target.endedAt ?? new Date().toISOString(),
    };
    if (terminalMeta.error)
        patch.error = terminalMeta.error;
    const updated = await patchRecordingIfStatus(stateDir, target.recordingId, ["analyzing", "stopped"], patch);
    if (updated) {
        return {
            recording: updated,
            transitioned: true,
            terminalStatus: terminalMeta.status,
        };
    }
    // CAS lost — another path already converged this recording. Return fresh
    // state so callers see the authoritative current status, but transitioned=
    // false so side-effect callers (watchdog metric/cleanup) skip emission.
    return {
        recording: (await getRecording(stateDir, target.recordingId)) ?? target,
        transitioned: false,
        terminalStatus: terminalMeta.status,
    };
}
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
export async function deriveStatusFromMeta(stateDir, target) {
    return (await deriveStatusFromMetaTransition(stateDir, target)).recording;
}
async function readTerminalMeta(promptDir) {
    if (!promptDir)
        return null;
    try {
        const raw = await fs.readFile(path.join(promptDir, "meta.json"), "utf8");
        const meta = JSON.parse(raw);
        if (meta.status !== "succeeded" && meta.status !== "failed")
            return null;
        const error = typeof meta.error === "string" && meta.error.length > 0
            ? meta.error
            : typeof meta.reason === "string" && meta.reason.length > 0
                ? meta.reason
                : undefined;
        return { status: meta.status, error };
    }
    catch {
        return null;
    }
}
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
export async function resolveInFlightAfterMeta(stateDir) {
    const inFlight = await pickDefaultRecording(stateDir, "in-flight-task");
    if (!inFlight)
        return null;
    const reconciled = await deriveStatusFromMeta(stateDir, inFlight);
    return ACTIVE_STATUSES.has(reconciled.status) ? reconciled : null;
}
/**
 * Convert an on-disk ReferenceSkillEntry (saveAsSkill artifact) into the same
 * RecordingView shape consumed by the front-end. Status is forced to
 * "succeeded" because reference entries are by definition saved-after-success
 * — without this, sort-by-status / status-filter would surface them under
 * whatever stale status meta.json happened to record.
 */
export function convertReferenceToView(ref) {
    return {
        recordingId: ref.recordingId,
        status: "succeeded",
        startedAt: ref.createdAt,
        endedAt: ref.createdAt,
        durationSec: ref.durationSec,
        sizeBytes: ref.sizeBytes,
        resolution: ref.resolution,
        format: null,
        videoPath: null,
        videoExists: false,
        promptDir: ref.promptDir,
        taskName: ref.taskName,
        promptPreview: ref.description,
        confidence: ref.confidence,
        savedSkills: [
            {
                scope: "vtp-reference",
                path: ref.promptDir,
                slug: ref.slug,
            },
        ],
        invocations: null,
        source: "reference",
        ffmpegAlive: false,
        skillAlive: false,
        error: null,
    };
}
//# sourceMappingURL=recording-state.js.map