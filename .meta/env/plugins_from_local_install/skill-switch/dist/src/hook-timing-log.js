import { createStream } from "rotating-file-stream";
export const HOOK_TIMING_LOG_DIR = "/var/log/openclaw_plugins_perf/hook_duration";
export const HOOK_TIMING_LOG_MAX_BYTES = "1M";
export const HOOK_TIMING_LOG_MAX_FILES = 2;
function createHookTimingStream(pluginId) {
    return createStream(`${pluginId}.log`, {
        path: HOOK_TIMING_LOG_DIR,
        size: HOOK_TIMING_LOG_MAX_BYTES,
        rotate: HOOK_TIMING_LOG_MAX_FILES,
    });
}
export class RotatingHookTimingLogWriter {
    streamFactory;
    streams = new Map();
    constructor(streamFactory = createHookTimingStream) {
        this.streamFactory = streamFactory;
    }
    resetStream(pluginId) {
        const stream = this.streams.get(pluginId);
        this.streams.delete(pluginId);
        if (!stream) {
            return;
        }
        try {
            stream.destroy();
        }
        catch {
            // silent-fail: logging must never affect hook behavior.
        }
    }
    ensureStream(pluginId) {
        const existing = this.streams.get(pluginId);
        if (existing && !existing.destroyed) {
            return existing;
        }
        if (existing?.destroyed) {
            this.streams.delete(pluginId);
        }
        try {
            const stream = this.streamFactory(pluginId);
            stream.on("error", () => {
                this.resetStream(pluginId);
            });
            stream.on("warning", () => {
                this.resetStream(pluginId);
            });
            this.streams.set(pluginId, stream);
            return stream;
        }
        catch {
            this.resetStream(pluginId);
            return null;
        }
    }
    appendLine(pluginId, line) {
        const stream = this.ensureStream(pluginId);
        if (!stream) {
            return;
        }
        try {
            stream.write(`${line}\n`, (error) => {
                if (error) {
                    this.resetStream(pluginId);
                }
            });
        }
        catch {
            this.resetStream(pluginId);
        }
    }
}
const defaultHookTimingLogWriter = new RotatingHookTimingLogWriter();
export function logHookTiming(api, hookName, startTimestamp, endTimestamp, writer = defaultHookTimingLogWriter) {
    const payload = {
        durationMs: endTimestamp - startTimestamp,
        hookName,
        pluginId: api.id,
        pluginVersion: api.version ?? null,
        startTimestamp,
        endTimestamp,
    };
    try {
        writer.appendLine(api.id, JSON.stringify(payload));
    }
    catch {
        // silent-fail: timing logging must never affect hook behavior.
    }
}
//# sourceMappingURL=hook-timing-log.js.map