import { deriveStatusFromMeta, getRecording, pickDefaultRecording, } from "../recording-state.js";
import { readPromptResult, promptDirForRecording } from "../result-reader.js";
import { respondError, redactError, viewOfRecording } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.result", async (ctx) => {
        await withRpcCommandSpan(ctx, "result", {}, async (ctx) => {
            try {
                const recordingId = typeof ctx.params?.recordingId === "string"
                    ? ctx.params.recordingId
                    : null;
                const includeLog = ctx.params?.includeLog === true;
                const includeSteps = ctx.params?.includeSteps === true;
                const stateDir = api.runtime.state.resolveStateDir();
                let target = null;
                if (recordingId) {
                    target = await getRecording(stateDir, recordingId);
                }
                else {
                    // L-18: pick the most recent recording that actually has artifacts to
                    // return (stopped/succeeded/failed). Picking `all[0]` would surface
                    // in-flight recordings whose prompt.json/meta.json don't exist yet.
                    target = await pickDefaultRecording(stateDir, "latest-completed");
                }
                if (!target) {
                    respondError(ctx, "RECORDING_NOT_FOUND", `No recording found${recordingId ? ` for id ${recordingId}` : ""}.`);
                    return;
                }
                const promptDir = target.promptDir || promptDirForRecording(target.recordingId, api);
                const result = await readPromptResult({
                    promptDir,
                    includeLog,
                    includeSteps,
                });
                // Single CAS source of truth — collapses analyzing/stopped → terminal
                // when meta.json says so. Discards the transition flag (read RPC
                // needs only the reconciled recording). Shared with cancel / start
                // gate / status / events handlers so reconcile semantics cannot drift.
                target = await deriveStatusFromMeta(stateDir, target);
                ctx.respond(true, {
                    recording: await viewOfRecording(api, target),
                    prompt: result.prompt,
                    meta: result.meta,
                    steps: result.steps,
                    log: result.log,
                    available: result.available,
                });
            }
            catch (err) {
                respondError(ctx, "INTERNAL_ERROR", redactError(err));
            }
        });
    });
}
//# sourceMappingURL=result.js.map