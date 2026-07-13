import { handleSaveAsSkill } from "./skill-persistence.js";
import { handleAnalyze, handleResult, handleStatus, } from "./analysis-lifecycle.js";
// R4-D: recording lifecycle (start/stop/pause/resume + auto-stop watchdog)
// extracted to recording-lifecycle.ts.
import { handleStart, handleStop, handlePause, handleResume, } from "./recording-lifecycle.js";
function parseArgs(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return {
            sub: null,
            recordingId: null,
            includeLog: false,
            includeSteps: false,
        };
    const tokens = trimmed.split(/\s+/);
    let sub = null;
    let recordingId = null;
    let includeLog = false;
    let includeSteps = false;
    const first = tokens.shift() ?? "";
    switch (first) {
        case "start":
        case "stop":
        case "cancel":
        case "pause":
        case "resume":
        case "analyze":
        case "save-skill":
        case "status":
        case "result":
        case "help":
            sub = first;
            break;
        default:
            sub = null;
    }
    for (const tok of tokens) {
        if (tok === "--log")
            includeLog = true;
        else if (tok === "--steps")
            includeSteps = true;
        else if (tok.startsWith("--"))
            continue;
        else if (!recordingId)
            recordingId = tok;
    }
    return { sub, recordingId, includeLog, includeSteps };
}
// VTP_RECORDING_INDEX_TEMPLATE moved to skill-persistence.ts (re-exported below).
function helpText() {
    return [
        "Usage:",
        "  /vtp-recording start                   Start ffmpeg desktop recording",
        "  /vtp-recording pause                   Pause active recording (SIGSTOP)",
        "  /vtp-recording resume                  Resume paused recording (SIGCONT)",
        "  /vtp-recording stop                    Stop ffmpeg; keep video for review (status=stopped)",
        "  /vtp-recording analyze [<id>]          Trigger skill analysis on a stopped recording",
        "  /vtp-recording save-skill [<id>]       Persist the prompt as a reusable skill",
        "  /vtp-recording cancel                  Stop and discard the recording (status=canceled)",
        "  /vtp-recording status [<id>]           Show active or specified recording",
        "  /vtp-recording result [<id>] [--log] [--steps]",
        "                                         Read generated prompt.json for a recording",
        "",
        "  (二期: list 子命令已删 — 录制域 v2 无 list,前端调 arkclawVtpRecording.listSkill 看任务模板)",
        "",
        "Config (openclaw.plugin.json):",
        "  maxRecordingSeconds (default 120)         user-facing cap; auto-stop fires here",
        "  maxRecordingGraceSeconds (default 10)     extra grace for ffmpeg hard cap",
        "  ffmpegBin (default 'ffmpeg')",
        "  display (default ':99')",
        "  resolution (default '1920x1080')",
        "  framerate (integer [1, 60], default 15)",
        "  skillScriptPath (default: skill-discovery 动态定位 video-to-prompt;未命中回退 <HOME>/.agents/skills/video-to-prompt/scripts/video-to-prompt.sh)",
    ].join("\n");
}
export function registerCuaRecordingCommand(api) {
    api.registerCommand({
        name: "vtp-recording",
        description: "Start/stop ECS desktop recording and convert to executable prompt",
        acceptsArgs: true,
        async handler(ctx) {
            const args = parseArgs(ctx.args ?? "");
            if (!args.sub || args.sub === "help") {
                return { text: helpText(), type: "help" };
            }
            switch (args.sub) {
                case "start":
                    return handleStart(api);
                case "stop":
                    return handleStop(api, { mode: "stop" });
                case "cancel":
                    return handleStop(api, { mode: "cancel" });
                case "pause":
                    return handlePause(api);
                case "resume":
                    return handleResume(api);
                case "analyze":
                    return handleAnalyze(api, args.recordingId);
                case "save-skill":
                    return handleSaveAsSkill(api, args.recordingId, {});
                case "status":
                    return handleStatus(api, args.recordingId);
                case "result":
                    return handleResult(api, args.recordingId, {
                        includeLog: args.includeLog,
                        includeSteps: args.includeSteps,
                    });
                // 二期: list 子命令已删 — 录制域 v2 无 list RPC,
                // 前端调 arkclawVtpRecording.listSkill 看任务模板
                default:
                    return { text: helpText(), type: "help" };
            }
        },
    });
}
// In-process mutex for handleStart: prevents two concurrent /vtp-recording
// start calls (slash command + gateway RPC + frontend double-click) from
// each spawning their own ffmpeg and racing on the Xvfb display slot.
// Cross-process safety for state.json mutation is already handled by the
// advisory file lock inside upsertRecording/patchRecording.
// R4 PR3-#14: 6 helpers moved to helpers.ts. Re-exported here so downstream
// importers (gateway / tests) keep working unchanged; new code should import
// from "./helpers.js" directly to avoid the legacy circular path.
export { makeSkillExitWatchdog, pluginConfig, readSkillsConfig, renderRecording, resolveSkillScriptRoots, validateSkillScriptPath, } from "./helpers.js";
// R4-D: recording lifecycle re-exports for back-compat.
export { handleStart, handleStop, handlePause, handleResume, scheduleAutoStop, cancelAutoStop, } from "./recording-lifecycle.js";
// tsW-size: skill persistence layer extracted to skill-persistence.ts so this
// file stays under the 800-line guideline. Re-exported to keep gateway.ts /
// cleanup-scheduler.ts / video-to-prompt.test.ts import paths stable.
export { handleSaveAsSkill, slugifySkillName, renderSkillMarkdown, VTP_RECORDING_INDEX_TEMPLATE, AUTO_INDEX_BEGIN, AUTO_INDEX_END, rebuildCuaRecordingIndex, } from "./skill-persistence.js";
// tsW-size: analysis-side handlers (analyze / status / result /
// updatePrompt + ACTION_ENUM + UpdatePrompt types) extracted to
// analysis-lifecycle.ts. Re-exported here for the same reason.
// 二期: handleList 已删 (list 子命令 / RPC 已删,前端调 listSkill)
export { handleAnalyze, handleCancelAnalysis, handleStatus, handleResult, handleUpdatePrompt, ACTION_ENUM, } from "./analysis-lifecycle.js";
// ADR-0028 (2026-05-21 amended): cleanupOldLogs(扫 runs/<rid>/prompt/skill.log
// 并按 recordingRetentionDays unlink)已随 skill.log 淘汰一并删除 —— ADR-0028
// 「cleanup-scheduler 不扫 .log 文件」。录制域整目录清理见 pruneOldRecordings。
//# sourceMappingURL=commands.js.map