import { spawn } from "node:child_process";
// @ts-ignore
import fs from "node:fs/promises";
// @ts-ignore
import path from "node:path";
export async function spawnFfmpegRecording(opts) {
    await fs.mkdir(path.dirname(opts.outputPath), { recursive: true });
    const logFd = await fs.open(opts.logPath, "a");
    const stream = logFd.createWriteStream();
    const args = [
        "-y",
        "-hide_banner",
        "-loglevel", "info",
        "-video_size", opts.resolution,
        "-framerate", String(opts.framerate),
        "-f", "x11grab",
        "-i", opts.display,
        "-t", String(opts.maxDurationSec),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",
        // DO NOT add `-movflags +faststart` here.
        // Faststart runs a "second pass" on SIGINT that rewrites the entire mp4
        // to relocate moov atom from tail to head. The graceMs=5000 window in
        // stopFfmpegRecording is not enough for an 8MB+ file under disk load,
        // so SIGKILL lands mid-rewrite and leaves moov atom in neither place →
        // ffprobe "moov atom not found" → preflight `video_corrupted` → skill
        // exit 2 → status=failed. vtp videos are consumed locally by ffprobe /
        // ffmpeg in the SEA binary (no HTTP streaming), so moov-at-tail is
        // strictly better here. Reported 2026-05-15 (rec_1778817136_*).
        opts.outputPath,
    ];
    const child = spawn(opts.ffmpegBin, args, {
        detached: true,
        stdio: ["ignore", stream, stream],
    });
    // R6 H1: WriteStream owns the fd once createWriteStream() wraps it. Direct
    // logFd.close() while the stream is mid-write triggers EBADF on the next
    // stream.write. Use stream.end(cb) which flushes then closes the fd. Same
    // pattern as skill-invoker.ts.
    let streamClosed = false;
    const closeStreamOnce = () => new Promise((resolve) => {
        if (streamClosed) {
            resolve();
            return;
        }
        streamClosed = true;
        try {
            stream.end(() => resolve());
        }
        catch {
            resolve();
        }
    });
    // W4 + R6 H1: attach lifecycle/error listeners immediately after spawn and
    // before unref/return. A failed spawn can emit "error" asynchronously; having
    // the listener in place before detaching prevents unhandled errors and closes
    // the log stream deterministically.
    child.once("exit", () => { closeStreamOnce().catch(() => { }); });
    child.once("error", () => { closeStreamOnce().catch(() => { }); });
    if (!child.pid || typeof child.pid !== "number") {
        await closeStreamOnce();
        throw new Error("ffmpeg spawn failed: no pid assigned");
    }
    child.unref();
    return { pid: child.pid };
}
export function isPidAlive(pid) {
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
export async function stopFfmpegRecording(pid, opts) {
    if (!pid || pid <= 0) {
        return { stopped: true, sigintSent: false, sigkillSent: false };
    }
    if (!isPidAlive(pid)) {
        return { stopped: true, sigintSent: false, sigkillSent: false };
    }
    let sigintSent = false;
    try {
        process.kill(pid, "SIGINT");
        sigintSent = true;
    }
    catch {
    }
    const grace = opts?.graceMs ?? 5000;
    const deadline = Date.now() + grace;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) {
            return { stopped: true, sigintSent, sigkillSent: false };
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    let sigkillSent = false;
    try {
        process.kill(pid, "SIGKILL");
        sigkillSent = true;
    }
    catch {
    }
    // R6 H11: poll for actual death rather than blanket sleep(300). SIGKILL is
    // delivered immediately by the kernel; the process disappears within a
    // tick or two on healthy systems. Polling at 50ms granularity exits faster
    // (typical: <100ms) and bounded by 1s for the rare uninterruptible-sleep
    // scenario (e.g. blocked on IO from a vanished mount).
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline) {
        if (!isPidAlive(pid)) {
            return { stopped: true, sigintSent, sigkillSent };
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    const stillAlive = isPidAlive(pid);
    return { stopped: !stillAlive, sigintSent, sigkillSent };
}
export async function probeVideoSize(videoPath) {
    try {
        const stat = await fs.stat(videoPath);
        if (stat.isFile() && stat.size > 0)
            return stat.size;
        return undefined;
    }
    catch {
        return undefined;
    }
}
export async function waitForFinalizedVideo(ffmpegBin, videoPath, opts) {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const stableIntervalMs = opts?.stableIntervalMs ?? 100;
    const minBytes = opts?.minBytes ?? 1024;
    const deadline = Date.now() + timeoutMs;
    const missingDeadline = Date.now() + Math.min(500, timeoutMs);
    while (Date.now() < deadline) {
        try {
            const first = await fs.stat(videoPath);
            if (!first.isFile() || first.size < minBytes) {
                await sleep(stableIntervalMs);
                continue;
            }
            await sleep(stableIntervalMs);
            const second = await fs.stat(videoPath);
            if (!second.isFile() || second.size < minBytes) {
                await sleep(stableIntervalMs);
                continue;
            }
            if (first.size !== second.size || first.mtimeMs !== second.mtimeMs) {
                await sleep(stableIntervalMs);
                continue;
            }
            const durationSec = await probeVideoDuration(ffmpegBin, videoPath);
            if (typeof durationSec === "number" && durationSec > 0) {
                return { sizeBytes: second.size, durationSec };
            }
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT" && Date.now() >= missingDeadline) {
                throw new Error(`video file not found after ffmpeg exit: ${videoPath}`);
            }
            // File may be transiently unavailable or still finalizing. Keep polling
            // until timeout so stopRecording does not expose a half-written mp4.
        }
        await sleep(stableIntervalMs);
    }
    throw new Error(`video not finalized within ${timeoutMs}ms: ${videoPath}`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function probeVideoDuration(ffmpegBin, videoPath) {
    // Derive ffprobe from ffmpeg by basename replacement. Covers:
    //   "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg", bare "ffmpeg",
    //   and Windows ".../ffmpeg.exe". Falls back to PATH "ffprobe" when the
    //   basename doesn't match.
    const base = ffmpegBin.split(/[\\/]/).pop() ?? ffmpegBin;
    const probeBase = /ffmpeg(\.exe)?$/i.test(base)
        ? base.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1")
        : null;
    const ffprobeBin = probeBase
        ? ffmpegBin.slice(0, ffmpegBin.length - base.length) + probeBase
        : "ffprobe";
    return new Promise((resolve) => {
        let out = "";
        let resolved = false;
        const settle = (v) => {
            if (resolved)
                return;
            resolved = true;
            resolve(v);
        };
        const p = spawn(ffprobeBin, [
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            videoPath,
        ], { stdio: ["ignore", "pipe", "ignore"] });
        // tsW14: hard 5s timeout — ffprobe 挂起（corrupted index / stuck reader）
        // would otherwise block handleStop forever. SIGKILL on timeout, return
        // undefined so caller falls back to size-only metadata.
        const timer = setTimeout(() => {
            try {
                p.kill("SIGKILL");
            }
            catch { /* ignore */ }
            settle(undefined);
        }, 5000);
        p.stdout.on("data", (chunk) => {
            out += String(chunk);
        });
        p.once("error", () => {
            clearTimeout(timer);
            settle(undefined);
        });
        p.once("close", () => {
            clearTimeout(timer);
            const val = parseFloat(out.trim());
            if (Number.isFinite(val) && val > 0)
                settle(val);
            else
                settle(undefined);
        });
    });
}
/**
 * Pause an actively-recording ffmpeg process via SIGSTOP. The process freezes
 * including its capture loop, so ffmpeg's -t (duration) does not advance.
 * Resume with SIGCONT.
 */
export function pauseFfmpegRecording(pid) {
    if (!pid || pid <= 0)
        return { paused: false, reason: "no_pid" };
    if (!isPidAlive(pid))
        return { paused: false, reason: "not_alive" };
    try {
        process.kill(pid, "SIGSTOP");
        return { paused: true };
    }
    catch (err) {
        return { paused: false, reason: String(err) };
    }
}
export function resumeFfmpegRecording(pid) {
    if (!pid || pid <= 0)
        return { resumed: false, reason: "no_pid" };
    if (!isPidAlive(pid))
        return { resumed: false, reason: "not_alive" };
    try {
        process.kill(pid, "SIGCONT");
        return { resumed: true };
    }
    catch (err) {
        return { resumed: false, reason: String(err) };
    }
}
export async function deleteVideoFile(videoPath) {
    try {
        await fs.unlink(videoPath);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=ffmpeg.js.map