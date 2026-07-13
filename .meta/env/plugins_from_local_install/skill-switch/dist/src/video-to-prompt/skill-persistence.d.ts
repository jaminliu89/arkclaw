import type { CommandResponse, OpenClawPluginApi } from "./types.js";
import { type PromptArtifact } from "./result-reader.js";
export interface SaveSkillOptions {
    prompt?: PromptArtifact;
    name?: string;
    description?: string;
    overwrite?: boolean;
}
export { AUTO_INDEX_BEGIN, AUTO_INDEX_END, TEMPLATE_VERSION, VTP_RECORDING_INDEX_TEMPLATE, rebuildCuaRecordingIndex, } from "./recording-index.js";
export declare function handleSaveAsSkill(api: OpenClawPluginApi, recordingId: string | null, opts: SaveSkillOptions): Promise<CommandResponse>;
export declare function slugifySkillName(input: string): string;
export declare function renderSkillMarkdown(args: {
    name: string;
    description: string;
    prompt: PromptArtifact;
    sourceRecordingId: string;
    durationSec?: number;
    resolution?: string;
    sizeBytes?: number;
    createdAt?: string;
}): string;
/**
 * E-7 dir-name == frontmatter.name strict consistency check.
 *
 * Anthropic Skills spec + OpenClaw skill standard both require
 * `path.basename(skillDir) === frontmatter.name`. saveAsSkill writes both
 * sides from the same `slug` variable, so newly written skills are always
 * consistent. Drift can only occur when a user manually edits SKILL.md and
 * changes `name:` without renaming the directory — at that point downstream
 * tooling (recording-index AUTO-INDEX rebuild, LRU pinned scan) reads
 * inconsistent identifiers and silently misroutes lookups.
 *
 * Returns a result type (no throw, ADR-0010 control-flow narrowing) so
 * callers can decide policy: handleSaveAsSkill treats inconsistency as a
 * post-write self-bug (warn + log); rebuildCuaRecordingIndex can warn and
 * skip the entry. Reading SKILL.md is best-effort — a missing or unparsable
 * file returns `{ ok: false, reason: "SKILL_MD_UNREADABLE" }` so the caller
 * can decide whether to treat it as drift.
 */
export declare function assertSkillNameConsistency(skillDir: string): Promise<{
    ok: true;
    name: string;
} | {
    ok: false;
    reason: "SKILL_NAME_DIR_MISMATCH" | "SKILL_MD_UNREADABLE" | "SKILL_NAME_MISSING";
    message: string;
    details: {
        skillDir: string;
        dirName: string;
        frontmatterName?: string;
    };
}>;
//# sourceMappingURL=skill-persistence.d.ts.map