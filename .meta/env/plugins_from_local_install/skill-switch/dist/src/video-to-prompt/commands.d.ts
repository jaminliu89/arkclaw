import type { OpenClawPluginApi } from "./types.js";
export declare function registerCuaRecordingCommand(api: OpenClawPluginApi): void;
export { makeSkillExitWatchdog, pluginConfig, readSkillsConfig, renderRecording, resolveSkillScriptRoots, validateSkillScriptPath, } from "./helpers.js";
export { handleStart, handleStop, handlePause, handleResume, scheduleAutoStop, cancelAutoStop, } from "./recording-lifecycle.js";
export { handleSaveAsSkill, slugifySkillName, renderSkillMarkdown, VTP_RECORDING_INDEX_TEMPLATE, AUTO_INDEX_BEGIN, AUTO_INDEX_END, rebuildCuaRecordingIndex, type SaveSkillOptions, } from "./skill-persistence.js";
export { handleAnalyze, handleCancelAnalysis, handleStatus, handleResult, handleUpdatePrompt, ACTION_ENUM, type UpdatePromptOptions, type UpdatePromptResponse, } from "./analysis-lifecycle.js";
//# sourceMappingURL=commands.d.ts.map