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
/**
 * Action vocabulary for `steps[].action`. Mirrored from analysis-lifecycle.ts
 * (re-exported from this module so callers can import a single source).
 */
export const ACTION_ENUM = [
    "click",
    "double_click",
    "right_click",
    "type",
    "select",
    "hotkey",
    "swipe",
    "scroll",
    "wait",
    "assert",
    "action",
];
/**
 * Fields a caller is permitted to overwrite on prompt.json. Provenance fields
 * (source / usage / recordingId / createdAt) intentionally absent — they are
 * sourced from existing prompt / recording metadata.
 */
// I-5 (V6.1): qualityNotice deliberately NOT exposed via updateSkill RPC —
// system-owned LLM-quality hint, frontend should not edit. 仍保留在 allowlist
// 内是为了 updatePrompt RPC (录制域,完整 prompt 覆写) 的兼容。
export const EDITABLE_PROMPT_KEYS = [
    "taskName",
    "description",
    "preconditions",
    "steps",
    "expectedResult",
    "confidence",
    "qualityNotice",
];
// V6.2 I6.2-1: SKILL_EDITABLE_PROMPT_KEYS = updateSkill RPC 暴露的字段
// (EDITABLE_PROMPT_KEYS 减 qualityNotice — system-owned LLM hint, deliberate
// exclude, 见 update-skill.ts handler 注释)。handler + store 两处复用此
// 常量,避免三处 SoT drift 让未来加字段时漏改。
export const SKILL_EDITABLE_PROMPT_KEYS = EDITABLE_PROMPT_KEYS.filter((k) => k !== "qualityNotice");
/**
 * Validate shape of an incoming prompt payload. Returns an array of human-
 * readable error strings (empty when the payload is acceptable).
 *
 * Type mismatches on allowlisted fields are REJECTED here (caller returns
 * PROMPT_VALIDATION_FAILED). This is the second line of defense after the
 * key allowlist — even known fields with wrong types (e.g. steps as string
 * instead of array) cannot be persisted.
 */
export function validatePromptShape(p) {
    const errs = [];
    if (typeof p.taskName !== "string" || !p.taskName.trim())
        errs.push("taskName must be a non-empty string");
    if (typeof p.description !== "string" || !p.description.trim())
        errs.push("description must be a non-empty string");
    if (typeof p.expectedResult !== "string" || !p.expectedResult.trim())
        errs.push("expectedResult must be a non-empty string");
    // N-4 (V6.1): IEEE 754 NaN 对所有比较 (<, >, ==) 都返回 false,所以
    // `typeof NaN === "number"` true + `NaN < 0` / `NaN > 1` 都 false →
    // 朴素三段检查会让 NaN 静默通过。Number.isFinite(NaN)=false 才能拦住。
    if (!Number.isFinite(p.confidence) ||
        p.confidence < 0 ||
        p.confidence > 1) {
        errs.push("confidence must be a finite number in [0,1]");
    }
    if (!Array.isArray(p.preconditions)) {
        errs.push("preconditions must be an array");
    }
    else if (!p.preconditions.every((x) => typeof x === "string")) {
        errs.push("preconditions must contain only strings");
    }
    if (!Array.isArray(p.steps) || p.steps.length === 0) {
        errs.push("steps must be a non-empty array");
    }
    else {
        p.steps.forEach((step, idx) => {
            if (!step || typeof step !== "object") {
                errs.push(`steps[${idx}] must be an object`);
                return;
            }
            const s = step;
            if (typeof s.action !== "string" ||
                !ACTION_ENUM.includes(s.action)) {
                errs.push(`steps[${idx}].action must be one of: ${ACTION_ENUM.join(", ")}`);
            }
            if (typeof s.target !== "string" || !s.target.trim()) {
                errs.push(`steps[${idx}].target must be a non-empty string`);
            }
            if (typeof s.description !== "string" || !s.description.trim()) {
                errs.push(`steps[${idx}].description must be a non-empty string`);
            }
            // N-4 (V6.1): 同 top-level confidence 的 NaN 防护。
            if (!Number.isFinite(s.confidence) ||
                s.confidence < 0 ||
                s.confidence > 1) {
                errs.push(`steps[${idx}].confidence must be a finite number in [0,1]`);
            }
        });
    }
    return errs;
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
export function normalizePromptEdit(existing, incoming, options = {}) {
    const reindex = options.reindexSteps !== false;
    const picked = {};
    for (const key of EDITABLE_PROMPT_KEYS) {
        if (key in incoming)
            picked[key] = incoming[key];
    }
    // Existing provides provenance (source / usage / recordingId / createdAt
    // and any non-editable extension fields). Spread existing first, then
    // allowlisted picks — picks win for the editable keys, provenance is
    // preserved untouched.
    const merged = { ...existing, ...picked };
    // Legacy migration: prior versions of ACTION_ENUM used "unknown" as the
    // generic-action sentinel. We renamed it to "action" (neutral term, also
    // safer when rendered to host LLM as it carries no false-confidence
    // signal). Existing reference/<slug>/prompt.json files written by older
    // SEA binaries may still contain action: "unknown". Migrate here so
    // downstream validate / render sees only the new value.
    if (Array.isArray(merged.steps)) {
        merged.steps = merged.steps.map((s, idx) => {
            const step = s;
            const migratedAction = step.action === "unknown" ? "action" : step.action;
            const next = {
                ...step,
                action: migratedAction,
            };
            if (reindex)
                next.stepIndex = idx + 1;
            return next;
        });
    }
    return merged;
}
//# sourceMappingURL=prompt-normalize.js.map