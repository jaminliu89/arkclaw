import { GPT5_BEHAVIOR_CONTRACT, GPT5_HEARTBEAT_PROMPT_OVERLAY, renderGpt5PromptOverlay, resolveGpt5SystemPromptContribution } from "openclaw/plugin-sdk/provider-model-shared";
//#region extensions/codex/prompt-overlay.ts
const CODEX_GPT5_BEHAVIOR_CONTRACT = GPT5_BEHAVIOR_CONTRACT;
const CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY = GPT5_HEARTBEAT_PROMPT_OVERLAY;
function resolveCodexSystemPromptContribution(params) {
	return resolveGpt5SystemPromptContribution(params);
}
function renderCodexPromptOverlay(params) {
	return renderGpt5PromptOverlay(params);
}
//#endregion
export { CODEX_GPT5_BEHAVIOR_CONTRACT, CODEX_GPT5_HEARTBEAT_PROMPT_OVERLAY, renderCodexPromptOverlay, resolveCodexSystemPromptContribution };
