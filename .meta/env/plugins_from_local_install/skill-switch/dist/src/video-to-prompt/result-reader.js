import fs from "node:fs/promises";
import path from "node:path";
import { vtpPromptDir, vtpVideoPath } from "./vtp-paths.js";
import { atomicWriteFileWithSync } from "./helpers.js";
async function readJsonIfExists(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
async function readJsonLinesIfExists(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const records = [];
        for (const line of lines) {
            try {
                records.push(JSON.parse(line));
            }
            catch {
                records.push({ raw: line });
            }
        }
        return records;
    }
    catch {
        return null;
    }
}
async function readTextIfExists(filePath, maxBytes = 64 * 1024) {
    try {
        const stat = await fs.stat(filePath);
        const fd = await fs.open(filePath, "r");
        try {
            if (stat.size <= maxBytes) {
                const buf = await fd.readFile();
                return buf.toString("utf8");
            }
            const offset = stat.size - maxBytes;
            const buf = Buffer.alloc(maxBytes);
            await fd.read(buf, 0, maxBytes, offset);
            return `...[truncated: showing last ${maxBytes} bytes]\n` + buf.toString("utf8");
        }
        finally {
            await fd.close();
        }
    }
    catch {
        return null;
    }
}
export async function readPromptResult(opts) {
    const promptPath = path.join(opts.promptDir, "prompt.json");
    const metaPath = path.join(opts.promptDir, "meta.json");
    const stepsPath = path.join(opts.promptDir, "steps.jsonl");
    // ADR-0028: 原 skill.log 已改名 events.jsonl(事件协议流,见 skill-invoker)。
    const logPath = path.join(opts.promptDir, "events.jsonl");
    const [prompt, meta, steps, log] = await Promise.all([
        readJsonIfExists(promptPath),
        readJsonIfExists(metaPath),
        opts.includeSteps ? readJsonLinesIfExists(stepsPath) : Promise.resolve(null),
        opts.includeLog ? readTextIfExists(logPath) : Promise.resolve(null),
    ]);
    return {
        prompt,
        meta,
        steps: steps ?? null,
        log: log ?? null,
        available: {
            prompt: prompt !== null,
            meta: meta !== null,
            steps: steps !== null,
            log: log !== null,
        },
    };
}
export function promptDirForRecording(recordingId, api) {
    return vtpPromptDir(recordingId, api);
}
/**
 * Atomically write a new prompt.json, backing up the previous file to prompt.json.bak.
 * Caller owns validation — this function only does filesystem I/O.
 *
 * Behavior:
 *   1. If prompt.json exists, copy it to prompt.json.bak (single-slot backup, overwritten each time).
 *   2. Write new content to prompt.json.tmp, then rename to prompt.json.
 *
 * Returns { bakCreated: boolean } so the caller can surface whether a rollback target exists.
 */
export async function writePromptFile(promptDir, prompt) {
    await fs.mkdir(promptDir, { recursive: true });
    const promptPath = path.join(promptDir, "prompt.json");
    const bakPath = path.join(promptDir, "prompt.json.bak");
    let bakCreated = false;
    try {
        await fs.copyFile(promptPath, bakPath);
        bakCreated = true;
    }
    catch {
        // prompt.json didn't exist — nothing to back up. OK.
    }
    // R8 Warn-②: prompt.json is the source-of-truth read by every result/
    // updatePrompt RPC. fsync the data file BEFORE rename so power-loss/SIGKILL
    // can't leave a renamed-but-empty target. Mirrors R7 H7 pattern.
    // R-Santa W8: atomicWriteFileWithSync derives `${target}.tmp` itself; the
    // tmpPath local was historical (3-arg variant). Pass `promptPath` only.
    await atomicWriteFileWithSync(promptPath, JSON.stringify(prompt, null, 2) + "\n");
    return { bakCreated };
}
/**
 * Write meta.json. Caller passes the full merged meta object.
 */
export async function writeMetaFile(promptDir, meta) {
    await fs.mkdir(promptDir, { recursive: true });
    const metaPath = path.join(promptDir, "meta.json");
    // R8 Warn-②: same fsync rationale as writePromptFile.
    // R-Santa W8: 2-arg form (target, data); tmp path derived internally.
    await atomicWriteFileWithSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
}
// R-Santa W8: local 3-arg atomicWriteFileWithSync removed; result-reader now
// uses the shared 2-arg helper from helpers.ts (target, data) — tmp path is
// derived internally as `${target}.tmp`.
export function videoPathForRecording(recordingId, api) {
    return vtpVideoPath(recordingId, api);
}
//# sourceMappingURL=result-reader.js.map