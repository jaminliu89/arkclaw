/**
 * Shared prompt edit normalization (B trust boundary).
 *
 * Both `handleUpdatePrompt` (RPC: edit existing prompt.json) and
 * `handleSaveAsSkill` (RPC: persist a recording as a reusable task template)
 * accept an incoming `prompt` object from the caller. To prevent prompt
 * injection via writable RPCs:
 *
 *   1. Positive allowlist `EDITABLE_PROMPT_KEYS` of user-editable fields.
 *      Anything outside the allowlist is silently dropped (see note below).
 *   2. Provenance fields (source / usage / recordingId / createdAt) are
 *      rebuilt from the existing prompt.json + recording metadata, never
 *      from the incoming payload.
 *   3. Shape validation via `validatePromptShape` — type / range / required
 *      checks on the allowlisted fields. Type errors REJECT the payload;
 *      they are not silently coerced.
 *
 * Why silent-drop instead of reject for unknown keys:
 *
 *   Existing frontend callers (saveAsSkill / updatePrompt) PUT the full
 *   prompt object including provenance fields. Switching to reject would
 *   break those callers without a frontend-side strip. The security goal
 *   is achieved by (1) + (2) above:
 *
 *     - Provenance fields cannot be injected — they always come from
 *       existing prompt / recording metadata.
 *     - Non-allowlisted fields are dropped, so they cannot influence the
 *       persisted artifact.
 *
 *   Switching to reject is tracked as a follow-up after a frontend caller
 *   audit confirms no client sends unrecognised fields.
 */
import type { PromptArtifact } from "./result-reader.js";
/**
 * Action vocabulary for `steps[].action`. Mirrored from analysis-lifecycle.ts
 * (re-exported from this module so callers can import a single source).
 */
export declare const ACTION_ENUM: readonly ["click", "double_click", "right_click", "type", "select", "hotkey", "swipe", "scroll", "wait", "assert", "action"];
/**
 * Fields a caller is permitted to overwrite on prompt.json. Provenance fields
 * (source / usage / recordingId / createdAt) intentionally absent — they are
 * sourced from existing prompt / recording metadata.
 */
export declare const EDITABLE_PROMPT_KEYS: readonly ["taskName", "description", "preconditions", "steps", "expectedResult", "confidence", "qualityNotice"];
export type EditablePromptKey = (typeof EDITABLE_PROMPT_KEYS)[number];
export declare const SKILL_EDITABLE_PROMPT_KEYS: ("description" | "steps" | "taskName" | "expectedResult" | "confidence" | "preconditions")[];
export type SkillEditablePromptKey = (typeof SKILL_EDITABLE_PROMPT_KEYS)[number];
/**
 * Validate shape of an incoming prompt payload. Returns an array of human-
 * readable error strings (empty when the payload is acceptable).
 *
 * Type mismatches on allowlisted fields are REJECTED here (caller returns
 * PROMPT_VALIDATION_FAILED). This is the second line of defense after the
 * key allowlist — even known fields with wrong types (e.g. steps as string
 * instead of array) cannot be persisted.
 */
export declare function validatePromptShape(p: Record<string, unknown>): string[];
export interface NormalizePromptEditOptions {
    /**
     * Re-number `steps[].stepIndex` to be sequential (1-based) after merge.
     * Default: true (matches updatePrompt default behavior).
     */
    reindexSteps?: boolean;
}
/**
 * Merge an incoming edit payload onto an existing prompt artifact. Only
 * fields in EDITABLE_PROMPT_KEYS are copied from `incoming`; all other keys
 * (including provenance) are sourced from `existing`.
 *
 * IMPORTANT (V6.1 注释修正): 真实调用契约是 — 先 normalize merge,**再** 对
 * merged 结果调用 `validatePromptShape`。验证 merged 比验证 incoming 更严
 * (incoming 是 partial,validate incoming 会因缺字段误报),且能捕获 existing
 * 中已固化的非法值 (例如老 prompt 含 NaN confidence 时,merge 后 validate
 * 会触发) — 这正是 updateSkillMetadata 走的路径。
 * 本 helper 自身不做 validation,仅按 EDITABLE_PROMPT_KEYS 过滤 key + 重建
 * provenance + 可选 reindex steps[].stepIndex。
 */
export declare function normalizePromptEdit(existing: PromptArtifact, incoming: Record<string, unknown>, options?: NormalizePromptEditOptions): PromptArtifact;
//# sourceMappingURL=prompt-normalize.d.ts.map