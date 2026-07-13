import type { OpenClawPluginApi, RecordingMetadata } from "./types.js";
import { type PromptArtifact } from "./result-reader.js";
export interface PreparePromptOptions {
    prompt?: PromptArtifact;
}
/**
 * Strict slug allowlist: letters / numbers / hyphen only (Unicode-aware).
 * Aligns with slugifySkillName output — saveAsSkill emits exactly this
 * shape, so a non-matching arg cannot be a real saveAsSkill artifact.
 *
 * Audit-Codex (Sprint A): the previous separator-only guard accepted
 * `.foo`, whitespace, and control-ish names that slugifySkillName would
 * never produce. Use the canonical predicate in both resolveExecute
 * RecordingId and tryLoadFromReference for consistency.
 */
export declare function isSafeReferenceSlug(slug: string): boolean;
/**
 * lstat-validated: refDir/<slug> exists, is a directory, and is NOT a
 * symbolic link. Audit-Codex (Sprint A): without this, an attacker who
 * can write under reference/ could plant a symlink (e.g. `vtp-evil → /etc`)
 * and have prompt resolution load meta.json + prompt.json through that
 * target dir, escaping the workspace.
 */
export declare function isRealReferenceDir(refDir: string, slug: string): Promise<boolean>;
/**
 * Accept either a recordingId (matches /^rec_/) or a saved-skill slug.
 * For a slug: read <workspace>/<vtpRecordingRoot>/reference/<slug>/meta.json
 * and return its recordingId field. On any failure (missing file, bad JSON,
 * missing field), return the original arg so downstream getRecording can
 * surface a clean "not found" error.
 *
 * Defence in depth (audit-Codex r2/r3):
 *  - isSafeReferenceSlug: strict Unicode allowlist [\p{L}\p{N}-]+ — refuses
 *    `.hidden`, whitespace, control chars, slashes, and dots (any non-slug
 *    shape slugifySkillName would never produce).
 *  - isRealReferenceDir: lstat-validated, refuses symbolic links so a
 *    planted symlink (e.g. reference/vtp-evil → /etc) cannot make us read
 *    workspace-external files for the recordingId field.
 */
export declare function resolveExecuteRecordingId(api: OpenClawPluginApi, workspace: string, arg: string | null): Promise<string | null>;
/**
 * Reference-first fallback. state.recordings is transient (plugin upgrade /
 * cleanup retention sweep / workspace migration clears it), but
 * reference/<slug>/ artifacts written by saveAsSkill are persistent. saved
 * skill replay must not depend on state still being alive — reconstruct an
 * ephemeral RecordingMetadata from on-disk meta.json + prompt.json.
 *
 * `arg` may be a slug (vtp-xxxxxx-xxxxxx) or a recordingId (rec_xxx). For a
 * recordingId, scan reference/* /meta.json to reverse-lookup the matching slug.
 *
 * Returns null when no reference artifact matches — caller surfaces "not
 * found" to keep the existing UX. No state mutation happens here; promptDir
 * points back to reference/<slug>/ for downstream readers.
 *
 * Path traversal defence on slug: same allowlist as resolveExecuteRecordingId
 * (reject `/`, `\`, `.`, `..`).
 */
export declare function tryLoadFromReference(api: OpenClawPluginApi, workspace: string, arg: string): Promise<{
    ephemeralRecording: RecordingMetadata;
    prompt: PromptArtifact;
} | null>;
/**
 * Fuzzy match a natural-language query (e.g. user's task name) against
 * reference/<slug>/{prompt.json,meta.json}.taskName + description + steps.
 *
 * Use case: callers of arkclawVtpRecording.renderInstruction (front-end
 * "💬 在聊天里运行" button or CLI users) pass a natural-language slug like
 *   { "slug": "用vim创建test.txt" }
 * instead of the precise
 *   { "slug": "vtp-test-2875394-0c9861" }
 *
 * Algorithm: tokenize query by Chinese punctuation + whitespace (keep tokens
 * >= 2 chars), then for each reference candidate count how many query tokens
 * appear as substrings in its haystack (taskName + description +
 * preconditions + step descriptions/targets + slug itself). Return top-1
 * slug iff its score is strictly greater than the runner-up's (avoids
 * ambiguous matches; caller surfaces "not found" so user can refine query).
 *
 * Symlink/path-traversal defense: same isSafeReferenceSlug + isRealReference
 * Dir gate as the rest of tryLoadFromReference.
 */
export declare function fuzzyMatchSlug(api: OpenClawPluginApi, workspace: string, query: string): Promise<string | null>;
export interface PreparedPrompt {
    recording: RecordingMetadata | null;
    promptText: string | null;
    prompt?: PromptArtifact | null;
    errorCode?: "RECORDING_NOT_FOUND" | "PROMPT_NOT_AVAILABLE" | "PROMPT_EMPTY";
    errorText?: string;
    errorDetails?: {
        recordingId?: string;
    };
}
/**
 * Pure resolver: takes a recordingId-or-slug-or-null and returns the rendered
 * instruction string for the renderInstruction RPC / list invocation pipeline.
 *
 * Includes all three target-resolution fallbacks:
 *   1. state.recordings lookup (or listRecordings for null arg)
 *   2. reference/<slug>/ fallback (tryLoadFromReference)
 *   3. fuzzy-match fallback (fuzzyMatchSlug → tryLoadFromReference)
 */
export declare function resolveAndPreparePrompt(api: OpenClawPluginApi, recordingId: string | null, opts: PreparePromptOptions): Promise<PreparedPrompt>;
export declare function renderTriggerSentence(taskName: string | null | undefined): string;
export declare function renderUserFacingPrompt(prompt: PromptArtifact): string;
//# sourceMappingURL=prompt-rendering.d.ts.map