// Single-process recording-domain mutation gate.
//
// VTP currently enforces one user task at a time. A global promise-chain gate is
// intentionally conservative: it serializes start/pause/resume/stop/analyze/
// cancel/delete/auto-stop so each handler can re-read state, check its
// precondition, and apply one state-machine transition without interleaving.
const lifecycleInflight = new Map();
const GLOBAL_KEY = "__vtp_lifecycle__";
export async function withRecordingLifecycleGate(run) {
    const prev = lifecycleInflight.get(GLOBAL_KEY) ?? Promise.resolve();
    let resolveInflight = () => { };
    const inflightPromise = new Promise((resolve) => {
        resolveInflight = resolve;
    });
    const myTurn = prev.then(() => inflightPromise);
    const stored = myTurn.catch(() => undefined);
    lifecycleInflight.set(GLOBAL_KEY, stored);
    stored.then(() => {
        if (lifecycleInflight.get(GLOBAL_KEY) === stored) {
            lifecycleInflight.delete(GLOBAL_KEY);
        }
    });
    try {
        await prev;
    }
    catch {
        // Prior RPC failure must not poison the queue for the next RPC.
    }
    try {
        return await run();
    }
    finally {
        resolveInflight();
    }
}
//# sourceMappingURL=lifecycle-gate.js.map