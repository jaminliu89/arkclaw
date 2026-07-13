// Analysis-side RPC handlers — the post-recording chain that drives the skill
// subprocess and exposes its outputs to callers. Extracted from commands.ts
// to satisfy the 800-line guideline (tsW-size). Public surface stable: every
// export here is re-exported from commands.ts so existing importers
// (gateway.ts / cleanup-scheduler.ts / video-to-prompt.test.ts) keep working.
import fs from "node:fs/promises";
import path from "node:path";
import { getRecording, deriveStatusFromMeta, isProcessAlive, patchRecording, patchRecordingIfStatus, pickDefaultRecording, } from "./recording-state.js";
import { invokeVideoToPromptSkill, resolveDefaultSkillScriptPath, } from "./skill-invoker.js";
import { vtpRunsRoot } from "./vtp-paths.js";
import { incrementCounter, recordHistogram } from "./observability/metrics.js";
import { promptDirForRecording, readPromptResult, writeMetaFile, writePromptFile, } from "./result-reader.js";
import { makeSkillExitWatchdog, pluginConfig, renderRecording, resolveSkillScriptRoots, validateSkillScriptPath, } from "./helpers.js";
import { withRecordingLifecycleGate } from "./lifecycle-gate.js";
import { normalizePromptEdit, validatePromptShape, } from "./prompt-normalize.js";
// ────────────────────────────────────────────────────────────────────────────
// analyze: stop → analyze 的显式入口（前端"生成提示词"按钮）
// ────────────────────────────────────────────────────────────────────────────
export async function handleAnalyze(api, recordingId) {
    return withRecordingLifecycleGate(() => handleAnalyzeGated(api, recordingId));
}
async function handleAnalyzeGated(api, recordingId) {
    // Resolve null id inside the unified recording lifecycle gate so a null-id
    // caller and an explicit-id caller for the same stopped recording cannot
    // interleave and spawn duplicate analysis work.
    const stateDir = api.runtime.state.resolveStateDir();
    let resolvedId = recordingId;
    if (!resolvedId) {
        const candidate = await pickDefaultRecording(stateDir, "latest-stopped");
        resolvedId = candidate?.recordingId ?? null;
    }
    return handleAnalyzeInner(api, resolvedId);
}
async function handleAnalyzeInner(api, recordingId) {
    const stateDir = api.runtime.state.resolveStateDir();
    const cfg = pluginConfig(api);
    let target = null;
    if (recordingId) {
        target = await getRecording(stateDir, recordingId);
    }
    else {
        target = await pickDefaultRecording(stateDir, "latest-stopped");
    }
    if (!target) {
        return {
            text: recordingId
                ? `No recording found for id ${recordingId}.`
                : "No stopped recording found to analyze.",
            type: "error",
        };
    }
    if (target.status === "analyzing") {
        const derived = await deriveStatusFromMeta(stateDir, target);
        if (derived.status !== "analyzing") {
            target = derived;
        }
        else if (isProcessAlive(target.skillPid)) {
            return {
                text: `Recording ${target.recordingId} is already analyzing.`,
                type: "stopped",
                recording: target,
                noop: true,
            };
        }
        else {
            // Zombie recovery: status=analyzing but skill PID not alive → watchdog
            // failed to patch state on exit (R8 M3 retry exhausted / host
            // OOM-killed / write fault). CAS to "failed" so concurrent cancel /
            // result-derive / startup reconcile that already converged the state
            // is respected — if CAS loses, the recording is no longer ours to
            // recover and we return a noop with fresh state.
            const recovered = await patchRecordingIfStatus(stateDir, target.recordingId, ["analyzing"], {
                status: "failed",
                error: `auto-recovered from zombie analyzing (skillPid ${target.skillPid ?? "?"} not alive)`,
                endedAt: target.endedAt ?? new Date().toISOString(),
            });
            if (!recovered) {
                // CAS lost — another path already converged this recording.
                // Surface authoritative current state instead of retrying analyze.
                const fresh = await getRecording(stateDir, target.recordingId);
                return {
                    text: `Recording ${target.recordingId} no longer analyzable (status=${fresh?.status ?? "unknown"}).`,
                    type: "stopped",
                    recording: fresh ?? target,
                    noop: true,
                };
            }
            target = recovered;
        }
    }
    if (target.status === "succeeded") {
        return {
            text: `Recording ${target.recordingId} already succeeded; analysis is complete.`,
            type: "stopped",
            recording: target,
            noop: true,
        };
    }
    if (target.status !== "stopped" && target.status !== "failed") {
        return {
            text: `Recording ${target.recordingId} cannot be analyzed (status=${target.status}).`,
            type: "error",
            recording: target,
        };
    }
    const skillScriptPath = cfg.skillScriptPath ?? resolveDefaultSkillScriptPath(api);
    const analyzeSkillAllowlist = resolveSkillScriptRoots(api);
    const analyzeSkillValidation = await validateSkillScriptPath(skillScriptPath, analyzeSkillAllowlist);
    if (!analyzeSkillValidation.ok) {
        return {
            text: `Refused to spawn skill: ${analyzeSkillValidation.reason}`,
            type: "error",
            recording: target,
        };
    }
    // C2: clear stale phase-state.json BEFORE spawn so the brief window between
    // patchRecording({status:"analyzing"}) and runtime's initPhaseState doesn't
    // leak the previous run's terminal snapshot to events RPC. Front-end would
    // otherwise read overallPercent=100 + done=true and stop polling. ENOENT-
    // tolerant by design — events handler returns 5 pending on absence (good
    // intermediate UI). Cheap unlink; rm with force ignores ENOENT.
    await fs
        .rm(path.join(target.promptDir, "phase-state.json"), { force: true })
        .catch(() => { });
    // coco-M1: 同时清 events.jsonl —— skill-invoker 是 append 模式,不清则重试
    // 分析的事件流会与上次混杂,events RPC since=0 重拉看到跨次事件。
    await fs
        .rm(path.join(target.promptDir, "events.jsonl"), { force: true })
        .catch(() => { });
    await fs
        .rm(path.join(target.promptDir, "meta.json"), { force: true })
        .catch(() => { });
    // P1-5: publish the analyzing state BEFORE spawning the detached skill.
    // Otherwise there is a window where the child is already running but state.json
    // still says stopped/failed, so start/status can miss the in-flight task and a
    // retry can spawn duplicate analysis work.
    let preSpawnPatched;
    try {
        preSpawnPatched = await patchRecording(stateDir, target.recordingId, {
            status: "analyzing",
            skillPid: undefined,
            error: undefined,
        });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
            text: `Analyze state update failed before spawn: ${errMsg}. Retry analyze.`,
            type: "error",
            recording: target,
        };
    }
    target = preSpawnPatched ?? {
        ...target,
        status: "analyzing",
        error: undefined,
    };
    // R11 P1-①: spawn-time exception (assertAbsoluteNoTraversal / fs.mkdir /
    // fs.open inside invokeVideoToPromptSkill can throw before the child process
    // exists). recording-lifecycle.ts:347-372 wraps its parallel call site
    // (handleStop mode=analyze) in try/catch already; this is the slash-command +
    // RPC `analyze` direct entry path that was missed in R10 W-①. Without this
    // guard, gateway's outer try → INTERNAL_ERROR but state.json is never patched
    // and recording is left in its prior status with no error trail.
    let invoked;
    try {
        invoked = await invokeVideoToPromptSkill({
            skillScriptPath: analyzeSkillValidation.resolved,
            videoPath: target.videoPath,
            promptDir: target.promptDir,
            recordingId: target.recordingId,
            allowedVideoRoot: vtpRunsRoot(api),
            onExit: makeSkillExitWatchdog(api, target.recordingId, target.promptDir),
        });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedPatch = await patchRecording(stateDir, target.recordingId, {
            status: "failed",
            error: `analyze spawn failed: ${errMsg}`,
        });
        return {
            text: `Analyze failed to spawn: ${errMsg}`,
            type: "error",
            recording: failedPatch ?? target,
        };
    }
    // W12: retry path (failed → analyzing) clears the stale error so downstream
    // doesn't see a contradiction ("status=analyzing" + leftover error).
    // H4: spawn 成功后子进程已 detach 在跑;若此 patch 抛错(state.json 锁超时
    // / 损坏 / IO 错),状态已是 analyzing 但缺 skillPid,用户可通过 cancel/reconcile
    // 恢复。失败时 best-effort kill 已 detach 的子进程并返回明确错误。
    let patched;
    try {
        patched = await patchRecording(stateDir, target.recordingId, {
            status: "analyzing",
            skillPid: invoked.pid,
            error: undefined,
        });
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
            process.kill(invoked.pid);
        }
        catch {
            // 子进程可能已自行退出 (ESRCH) — 忽略
        }
        return {
            text: `Analyze spawned but state update failed (killed pid ${invoked.pid}): ${errMsg}. Retry analyze.`,
            type: "error",
            recording: target,
        };
    }
    return {
        text: [
            `Analysis started.`,
            renderRecording(patched ?? target),
            "",
            `Events log: ${invoked.logPath}`,
            `Poll /vtp-recording result ${target.recordingId} to check progress.`,
        ].join("\n"),
        type: "stopped",
        recording: patched ?? target,
    };
}
// ────────────────────────────────────────────────────────────────────────────
// cancel: user-initiated interruption of an in-progress analyze
// ────────────────────────────────────────────────────────────────────────────
/**
 * Cancel an in-progress analyze run. Mirrors handleAnalyze's gate pattern so
 * cancel and analyze on the same recordingId serialize. Kills the skill
 * subprocess (SIGTERM + 1s SIGKILL fallback), polls up to 3s for exit, removes
 * stale phase/events files, then patches the recording to terminal
 * status="canceled" with an explicit "canceled by user" marker.
 *
 * Zombie path (status=analyzing but skillPid not alive) is handled: kill is
 * skipped, but cleanup + terminal cancel patch still happen.
 */
export async function handleCancelAnalysis(api, recordingId) {
    return withRecordingLifecycleGate(() => handleCancelAnalysisGated(api, recordingId));
}
async function handleCancelAnalysisGated(api, recordingId) {
    if (!recordingId) {
        return {
            type: "error",
            text: "recordingId is required.",
            errorCode: "INVALID_REQUEST",
        };
    }
    const stateDir = api.runtime.state.resolveStateDir();
    return handleCancelAnalysisInner(api, stateDir, recordingId);
}
async function handleCancelAnalysisInner(api, stateDir, recordingId) {
    const target = await getRecording(stateDir, recordingId);
    if (!target) {
        return {
            type: "error",
            text: `No recording found for id ${recordingId}.`,
            errorCode: "RECORDING_NOT_FOUND",
        };
    }
    if (target.status === "canceled" && target.error === "canceled by user") {
        return {
            type: "stopped",
            text: `Analysis already canceled. ${recordingId} is status=canceled.`,
            recording: target,
            noop: true,
        };
    }
    if (target.status !== "analyzing") {
        return {
            type: "error",
            text: `Recording ${recordingId} status=${target.status} is not cancelable. Only analyzing recordings can be canceled.`,
            errorCode: "RECORDING_NOT_ANALYZING",
            recording: target,
        };
    }
    // Snapshot pid before any state mutation; patchRecording later writes
    // skillPid=undefined and we still need the original pid to drive
    // SIGTERM/SIGKILL.
    const skillPid = target.skillPid;
    // Kill skill if it's alive. Zombie path (analyzing + dead pid) just skips
    // to cleanup + patch.
    if (skillPid && isProcessAlive(skillPid)) {
        try {
            process.kill(skillPid, "SIGTERM");
        }
        catch {
            /* already gone — race with watchdog */
        }
        // SIGKILL grace follow-up; mirrors recording-lifecycle.ts:310-323. unref()
        // so the timer doesn't keep Node alive past process end.
        setTimeout(() => {
            if (isProcessAlive(skillPid)) {
                try {
                    process.kill(skillPid, "SIGKILL");
                }
                catch {
                    /* gone */
                }
            }
        }, 1000).unref();
        // Poll up to 3s for skill to exit. Bounded so cancel RPC stays responsive
        // even when the skill traps signals; watchdog onExit will still patch
        // state eventually if our patch races it.
        const deadline = Date.now() + 3000;
        while (isProcessAlive(skillPid) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    // #15 (review 2026-05-24): skill 可能在 cancel 的 SIGTERM/poll 窗口内自己
    // 跑完 (succeeded 或 failed,已写终态 meta.json)。统一调 deriveStatusFromMeta
    // 把 analyzing→meta-terminal 收敛(单一 CAS source of truth,与 result /
    // startup / start gate 共享)。derive 后若已是 succeeded 或 failed,按
    // "终态不可 cancel" 语义返回 not cancelable,让 analyzer 自己的终态显式
    // 展示给用户,而不是被 cancel 覆盖成 canceled。
    const derived = await deriveStatusFromMeta(stateDir, target);
    if (derived.status === "succeeded" || derived.status === "failed") {
        return {
            type: "error",
            text: `Recording ${recordingId} analysis already ${derived.status} before cancel took effect; not cancelable.`,
            errorCode: "RECORDING_NOT_ANALYZING",
            recording: derived,
        };
    }
    // Clear stale phase-state.json so next analyze starts from clean slate
    // (same rationale as C2 fix in handleAnalyze).
    await fs
        .rm(path.join(target.promptDir, "phase-state.json"), { force: true })
        .catch(() => { });
    // coco-M1: 同时清 events.jsonl —— skill-invoker 是 append 模式,不清则重试
    // 分析的事件流会与上次混杂,events RPC since=0 重拉看到跨次事件。
    await fs
        .rm(path.join(target.promptDir, "events.jsonl"), { force: true })
        .catch(() => { });
    // Patch recording: CAS to "canceled" — only when state is still "analyzing".
    // derive above already collapsed analyzing→terminal-meta if applicable, so
    // reaching here with status=analyzing means analyzer hasn't (yet) written
    // terminal meta. CAS catches the residual race where analyzer wrote meta
    // after our derive but before this patch — refuse to overwrite real
    // terminal state with canceled.
    const patched = await patchRecordingIfStatus(stateDir, recordingId, ["analyzing"], {
        status: "canceled",
        error: "canceled by user",
        skillPid: undefined,
        endedAt: target.endedAt ?? new Date().toISOString(),
    });
    if (!patched) {
        const fresh = await getRecording(stateDir, recordingId);
        return {
            type: "error",
            text: `Recording ${recordingId} status changed to ${fresh?.status ?? "unknown"} before cancel could complete; not cancelable.`,
            errorCode: "RECORDING_NOT_ANALYZING",
            recording: fresh ?? target,
        };
    }
    // CAS won — this cancel call owns the terminal transition. metric +
    // audit log are gated on patched (CAS success) so racing cancel calls
    // or watchdog-then-cancel sequences won't double-count vtp.recording.total.
    incrementCounter("vtp.recording.total", { result: "canceled" });
    const cancelDurationMs = target.startedAt
        ? Date.now() - new Date(target.startedAt).getTime()
        : 0;
    recordHistogram("vtp.recording.duration", Math.max(0, cancelDurationMs), {
        result: "canceled",
    });
    api.logger?.info?.(`[video-to-prompt] cancel: ${recordingId} (was analyzing, skillPid=${skillPid ?? "?"})`);
    return {
        type: "stopped",
        text: `Analysis canceled. ${recordingId} is now status=canceled.`,
        recording: patched,
    };
}
// ────────────────────────────────────────────────────────────────────────────
// status / result / list — read-only views over state.json + promptDir
// ────────────────────────────────────────────────────────────────────────────
export async function handleStatus(api, recordingId) {
    const stateDir = api.runtime.state.resolveStateDir();
    // Without an explicit id, surface the in-flight task — same selector as the
    // start RPC gate (pickDefaultRecording("in-flight-task")). Earlier this used
    // getActiveRecording → resumable-stopped, but lifecycle clears
    // state.activeRecordingId the instant a stop→analyzing transition happens,
    // and the resumable-stopped fallback only matches status==="stopped". So
    // analyzing tasks slipped past status RPC and the front end reported
    // "No recording found" while a skill subprocess was actively writing
    // prompt-state.json. The in-flight-task selector covers
    // {recording, paused, analyzing} plus stopped+video, matching the
    // single-task contract enforced by start.
    let target = null;
    if (recordingId) {
        target = await getRecording(stateDir, recordingId);
    }
    else {
        target = await pickDefaultRecording(stateDir, "in-flight-task");
    }
    if (!target) {
        return { text: "No recording found.", type: "status", recording: null };
    }
    const alive = isProcessAlive(target.ffmpegPid);
    const skillAlive = isProcessAlive(target.skillPid);
    const lines = [
        `Recording status:`,
        renderRecording(target),
        `  ffmpegAlive: ${alive}`,
        `  skillAlive:  ${skillAlive}`,
    ];
    return { text: lines.join("\n"), type: "status", recording: target };
}
export async function handleResult(api, recordingId, opts) {
    const stateDir = api.runtime.state.resolveStateDir();
    let target = null;
    if (recordingId) {
        target = await getRecording(stateDir, recordingId);
    }
    else {
        // L-18: "result" semantically needs a recording with prompt artifacts on
        // disk. Picking `all[0]` would surface an in-flight recording/paused/
        // analyzing run whose meta.json/prompt.json don't exist yet, returning a
        // confusing {recording, prompt:null, meta:null} envelope. "latest-completed"
        // filters to stopped / succeeded / failed — the three states for which
        // readPromptResult below can meaningfully derive status.
        target = await pickDefaultRecording(stateDir, "latest-completed");
    }
    if (!target) {
        return { text: "No recording found.", type: "error" };
    }
    const promptDir = target.promptDir || promptDirForRecording(target.recordingId, api);
    const result = await readPromptResult({
        promptDir,
        includeLog: opts.includeLog,
        includeSteps: opts.includeSteps,
    });
    if (!result.available.prompt) {
        const lines = [
            `Prompt not available yet for ${target.recordingId}.`,
            `  promptDir: ${promptDir}`,
            `  available: ${JSON.stringify(result.available)}`,
        ];
        if (result.meta?.status === "running" || target.status === "analyzing") {
            lines.push("Analysis still running. Try again shortly.");
        }
        else if (result.meta?.status === "failed" || target.status === "failed") {
            lines.push(`Analysis failed: ${result.meta?.error ?? target.error ?? "unknown"}`);
        }
        return {
            text: lines.join("\n"),
            type: "error",
            recording: target,
            prompt: null,
        };
    }
    const prompt = result.prompt;
    const body = [
        `Prompt for ${target.recordingId}:`,
        "",
        `  taskName:    ${prompt.taskName ?? "(unknown)"}`,
        `  confidence:  ${prompt.confidence ?? "n/a"}`,
        `  steps:       ${(prompt.steps ?? []).length}`,
        `  createdAt:   ${prompt.createdAt ?? "n/a"}`,
        "",
        `Full JSON at: ${path.join(promptDir, "prompt.json")}`,
    ];
    if (opts.includeLog && result.log) {
        body.push("", "--- events.jsonl (tail) ---", result.log);
    }
    return {
        text: body.join("\n"),
        type: "result",
        recording: target,
        prompt: result,
    };
}
// 二期: handleList 已删除 — 录制域 v2 无 list,前端调
// arkclawVtpRecording.listSkill (任务模板域) 看已保存任务。
// ────────────────────────────────────────────────────────────────────────────
// updatePrompt — full-object overwrite with editable-field allowlist
// ────────────────────────────────────────────────────────────────────────────
// ACTION_ENUM moved to prompt-normalize.ts; re-export so existing external
// importers (if any future caller needs the vocabulary) keep working.
export { ACTION_ENUM } from "./prompt-normalize.js";
export async function handleUpdatePrompt(api, recordingId, opts) {
    const stateDir = api.runtime.state.resolveStateDir();
    if (!opts?.prompt || typeof opts.prompt !== "object") {
        return {
            type: "error",
            text: "prompt object is required.",
            errorCode: "INVALID_REQUEST",
        };
    }
    // I3 (L-18 follow-up): align default-pick with handleAnalyze/handleResult/
    // handleStatus — all of which moved to pickDefaultRecording. Update-prompt
    // semantically needs a recording with prompt.json on disk, so the same
    // "latest-completed" intent (stopped / succeeded / failed) applies.
    let target = null;
    if (recordingId) {
        target = await getRecording(stateDir, recordingId);
    }
    else {
        target = await pickDefaultRecording(stateDir, "latest-completed");
    }
    if (!target) {
        return {
            type: "error",
            text: recordingId
                ? `Recording ${recordingId} not found.`
                : "No recordings exist; nothing to update.",
            errorCode: "RECORDING_NOT_FOUND",
        };
    }
    if (target.status === "recording" ||
        target.status === "paused" ||
        target.status === "analyzing") {
        return {
            type: "error",
            text: `Cannot edit prompt while recording.status=${target.status}. Wait until succeeded/failed/stopped.`,
            errorCode: "RECORDING_BUSY",
            recording: target,
        };
    }
    const promptDir = target.promptDir || promptDirForRecording(target.recordingId, api);
    const promptPath = path.join(promptDir, "prompt.json");
    // Require that prompt.json already exists (i.e. analyze ran successfully).
    // This anchors source/usage/recordingId to AI-generated baseline rather
    // than something invented by the frontend.
    try {
        await fs.access(promptPath);
    }
    catch {
        return {
            type: "error",
            text: `prompt.json not found at ${promptPath}. Run analyze first.`,
            errorCode: "PROMPT_NOT_FOUND",
            recording: target,
        };
    }
    // C2: strict allowlist for user-editable fields. source/usage/recordingId/
    // createdAt are provenance fields; the frontend must not be able to rewrite
    // them by sending a shaped payload.
    let existingPrompt = {};
    try {
        existingPrompt = JSON.parse(await fs.readFile(promptPath, "utf8"));
    }
    catch {
        return {
            type: "error",
            text: `prompt.json at ${promptPath} is unreadable.`,
            errorCode: "PROMPT_NOT_FOUND",
            recording: target,
        };
    }
    // B (shared helper): allowlist + provenance rebuild lives in prompt-normalize.ts
    // so saveAsSkill uses the exact same normalization rules. Unknown keys are
    // silently dropped (documented compatibility decision).
    //
    // 调用 contract:normalize 在前、validate(merged) 在后 — 见
    // prompt-normalize.ts:170-178。normalize 不仅 merge picks 还做 legacy
    // migration (e.g. step.action: "unknown"→"action"),先 normalize 才能让
    // validate 看到迁移后的合规数据;反过来则会在跨版本部署窗口期把含 legacy
    // "unknown" 的 prompt 误拒。
    const newPrompt = normalizePromptEdit(existingPrompt, opts.prompt, { reindexSteps: opts.reindexSteps });
    const errs = validatePromptShape(newPrompt);
    if (errs.length > 0) {
        return {
            type: "error",
            text: `Prompt validation failed: ${errs.length} issue(s).`,
            errorCode: "PROMPT_VALIDATION_FAILED",
            recording: target,
            errors: errs,
        };
    }
    const { bakCreated } = await writePromptFile(promptDir, newPrompt);
    // Patch meta.json: editedAt + bump editedRevisions
    const metaPath = path.join(promptDir, "meta.json");
    let meta = {};
    try {
        meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    }
    catch {
        // meta.json missing is tolerated — recording may predate meta emission
    }
    const nextRevision = (typeof meta.editedRevisions === "number" ? meta.editedRevisions : 0) + 1;
    const nextMeta = {
        ...meta,
        editedAt: new Date().toISOString(),
        editedRevisions: nextRevision,
    };
    await writeMetaFile(promptDir, nextMeta);
    api.logger?.info?.(`[video-to-prompt] prompt updated for ${target.recordingId} (revision=${nextRevision}, bak=${bakCreated})`);
    return {
        type: "updated",
        text: `Prompt updated (revision ${nextRevision}).`,
        recording: target,
        prompt: newPrompt,
        meta: nextMeta,
        revision: nextRevision,
        bakCreated,
    };
}
//# sourceMappingURL=analysis-lifecycle.js.map