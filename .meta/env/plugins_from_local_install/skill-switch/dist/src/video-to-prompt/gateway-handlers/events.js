import fs from "node:fs/promises";
import path from "node:path";
import { deriveStatusFromMeta, getRecording, isProcessAlive, } from "../recording-state.js";
import { promptDirForRecording } from "../result-reader.js";
import { readPhaseStateFile, finalizedPhaseProgress, } from "../phase-progress.js";
import { respondError, redactError, viewOfRecording, MAX_LOG_TAIL_BYTES, } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
// R8 M1: per-recordingId in-flight gate for events RPC. Coalesces concurrent
// polls so at most one MAX_LOG_TAIL_BYTES Buffer.alloc is live per recording
// at any moment (front-end timer drift can otherwise queue 3-5 calls in <1s).
const eventsInflight = new Map();
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.events", async (ctx) => {
        await withRpcCommandSpan(ctx, "events", {}, async (ctx) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                if (!recordingId) {
                    respondError(ctx, "INVALID_REQUEST", "recordingId is required");
                    return;
                }
                // B-4: recordingId 白名单 —— events RPC 后续用它派生
                // promptDir(runs/<rid>/prompt)读 events.jsonl;挡 ../ 路径
                // 穿越。generateRecordingId 产出 rec_<秒>_<hex> 全命中。
                if (!/^[A-Za-z0-9_-]+$/.test(recordingId)) {
                    respondError(ctx, "INVALID_REQUEST", "invalid recordingId");
                    return;
                }
                // R8 M1 + R-Round-N M3: serialize concurrent polls on the same
                // recordingId so high-frequency front-end polling doesn't stack
                // multiple MAX_LOG_TAIL_BYTES (=10MB) Buffer allocations.
                //
                // Old impl had a TOCTOU window: get(prev) → await prev → set new gate.
                // During the await window, multiple waiters all observed the SAME
                // prev and all moved past it concurrently — defeating the gate. Fix:
                // register our turn ATOMICALLY by chaining .then() on prev and
                // storing the chained promise back into the Map in the same sync tick,
                // so any later caller picks up our promise as their prev.
                const prev = eventsInflight.get(recordingId) ?? Promise.resolve();
                let resolveInflight = () => { };
                const inflightPromise = new Promise((resolve) => {
                    resolveInflight = resolve;
                });
                // Store our chained promise (prev → our work) so the next caller
                // chains on top of OUR completion, not prev's. Suppressed via .catch
                // so a never-awaited tail isn't reported as unhandled rejection.
                const myTurn = prev.then(() => inflightPromise);
                const stored = myTurn.catch(() => undefined);
                eventsInflight.set(recordingId, stored);
                // R-review-fix M5: schedule auto-cleanup once our chained promise
                // settles. The previous race(head, Promise.resolve("__pending__"))
                // inside finally was unreliable — Promise.resolve always settled
                // first → the delete branch never fired and the Map grew unbounded
                // across polls. Clean up here as soon as our chain completes; the
                // identity-check guards against a later caller already chaining on top.
                stored.then(() => {
                    if (eventsInflight.get(recordingId) === stored) {
                        eventsInflight.delete(recordingId);
                    }
                });
                // Now actually wait for prev before reading events.jsonl; once we are
                // ready to release, resolveInflight() lets the next chained waiter
                // proceed.
                try {
                    await prev;
                }
                catch {
                    /* ignore prior error — RPC isolation */
                }
                try {
                    let since = typeof ctx.params?.since === "number" && ctx.params.since >= 0
                        ? Math.floor(ctx.params.since)
                        : 0;
                    const stateDir = api.runtime.state.resolveStateDir();
                    let target = await getRecording(stateDir, recordingId);
                    if (!target) {
                        respondError(ctx, "RECORDING_NOT_FOUND", `No recording found for id ${recordingId}`);
                        return;
                    }
                    target = await deriveStatusFromMeta(stateDir, target);
                    const promptDir = target.promptDir || promptDirForRecording(target.recordingId, api);
                    // ADR-0028 (2026-05-21 amended): 事件协议流文件 —— 原 skill.log 已
                    // 改名 events.jsonl(skill.log 名字淘汰)。events RPC 从这里 tail
                    // runtime emit 的 JSON 事件,回放给前端。
                    const logPath = path.join(promptDir, "events.jsonl");
                    let events = [];
                    let nextCursor = since;
                    let logSize = 0;
                    let truncated = false;
                    try {
                        const stat = await fs.stat(logPath);
                        logSize = stat.size;
                        if (stat.size < since) {
                            since = 0;
                            nextCursor = 0;
                        }
                        if (stat.size > since) {
                            const fd = await fs.open(logPath, "r");
                            try {
                                const available = stat.size - since;
                                const len = Math.min(available, MAX_LOG_TAIL_BYTES);
                                truncated = available > MAX_LOG_TAIL_BYTES;
                                const buf = Buffer.alloc(len);
                                await fd.read(buf, 0, len, since);
                                const text = buf.toString("utf8");
                                const lastNl = text.lastIndexOf("\n");
                                const oversizedLineWithoutNewline = truncated && lastNl < 0;
                                const consumable = lastNl >= 0 ? text.slice(0, lastNl) : "";
                                const remainder = lastNl >= 0 ? text.slice(lastNl + 1) : text;
                                // R-Coco H2 (clarification): nextCursor placement.
                                // - truncated: anchor at READ-WINDOW END minus the partial trailing
                                //   line (`since + len - remainder`). The next poll starts at this
                                //   cursor and the partial line carries over, so events between
                                //   `since + len` and `stat.size` are FETCHED IN THE FOLLOWING
                                //   call's window, not dropped. Pagination is fully resumable; a
                                //   client that loops until `truncated === false` sees every byte.
                                // - not truncated: anchor at FILE END minus the partial trailing
                                //   line so the next poll only re-reads the open trailing line.
                                nextCursor = truncated
                                    ? since + len - Buffer.byteLength(remainder, "utf8")
                                    : stat.size - Buffer.byteLength(remainder, "utf8");
                                if (oversizedLineWithoutNewline) {
                                    nextCursor = since + len;
                                    events.push({
                                        seq: nextCursor,
                                        type: "warning",
                                        code: "EVENT_LINE_TOO_LARGE",
                                        message: `events.jsonl contains a line larger than ${MAX_LOG_TAIL_BYTES} bytes; skipped one read window`,
                                    });
                                }
                                const lines = consumable
                                    .split("\n")
                                    .filter((l) => l.trim().length > 0);
                                // R8 N3: `seq` here is the byte offset of the END of each line,
                                // not the start. Front-end uses `nextCursor` (computed above) for
                                // pagination, not seq — seq is purely an event-ordering token
                                // emitted in the response. Off-by-one of "first event seq starts
                                // past line end" doesn't affect ordering or pagination because
                                // strict-monotonic is enough.
                                let seq = since;
                                for (const line of lines) {
                                    try {
                                        const obj = JSON.parse(line);
                                        if (obj &&
                                            typeof obj === "object" &&
                                            typeof obj.type === "string") {
                                            seq += Buffer.byteLength(line, "utf8") + 1;
                                            events.push({ seq, ...obj });
                                        }
                                    }
                                    catch {
                                        // not a JSON event line; ignore
                                    }
                                }
                            }
                            finally {
                                await fd.close();
                            }
                        }
                    }
                    catch {
                        // log file not yet present — skill hasn't started or just spawned
                    }
                    const skillAlive = isProcessAlive(target.skillPid);
                    const terminal = target.status === "succeeded" ||
                        target.status === "failed" ||
                        target.status === "canceled";
                    const done = terminal || (target.status === "analyzing"
                        ? Boolean(target.skillPid) && !skillAlive
                        : !skillAlive);
                    // ADR-0022: phase 状态权威源是 <promptDir>/phase-state.json,由 runtime
                    // 在每次 phase emit 时同步原子写。本路径不再做事件回放(已删除
                    // derivePhaseProgress),彻底解耦 phase 状态与 events 增量协议——前端
                    // 任意 since 取值都不会让 phase 状态退化(根因见 ADR-0022)。
                    // 兜底链:
                    //   1) phase-state.json 存在 → 直接读
                    //   2) 文件缺失 / IO 失败 → 返回 5 个 pending(等价 derivePhaseProgress
                    //      初始状态),不阻断响应
                    //   3) recording 终态 + phase-state 仍有 pending(runtime 进程异常退出
                    //      没跑 finalize) → finalizedPhaseProgress 兜底刷,语义对齐原
                    //      derivePhaseProgress:111-118
                    const phaseFile = await readPhaseStateFile(promptDir);
                    const { phaseProgress, overallPercent } = finalizedPhaseProgress(phaseFile, target.status);
                    ctx.respond(true, {
                        recording: await viewOfRecording(api, target),
                        recordingId: target.recordingId,
                        status: target.status,
                        events,
                        nextCursor,
                        logSize,
                        truncated,
                        skillAlive,
                        done,
                        phaseProgress,
                        overallPercent,
                    });
                }
                finally {
                    // R-review-fix M5: release the in-flight slot for the next polling
                    // caller. Map cleanup is now scheduled at chain creation time
                    // (`stored.then(...)` above) — the race-based finally cleanup that
                    // lived here was unreliable.
                    resolveInflight();
                }
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=events.js.map