import type { OpenClawPluginApi, SkillView, SkillDetail } from "./types.js";
/**
 * Resolve <workspace>/<vtpRecordingRoot>/reference/.
 */
export declare function resolveReferenceDir(api: OpenClawPluginApi): string;
export declare function listAllSkills(refDir: string, opts?: {
    q?: string;
    limit?: number;
    offset?: number;
}): Promise<{
    skills: SkillView[];
    total: number;
}>;
export declare function readSkillDetail(api: OpenClawPluginApi, slug: string): Promise<SkillDetail | null>;
export declare function deleteSavedSkill(refDir: string, slug: string): Promise<{
    deleted: boolean;
    alreadyDeleted: boolean;
    deleteFailed?: boolean;
    errors?: Array<{
        op: string;
        path: string;
        message: string;
        code?: string;
    }>;
}>;
/**
 * Patch shape for updateSkillMetadata.
 *
 * C-1 (V6.1): 不再接受 `name` 字段 — E-7 不变式要求 SKILL.md frontmatter
 * `name:` === dir 名 (= slug),前端 UI "任务名称" 走 `taskName` (写
 * prompt.json + SKILL.md body 标题)。renderSkillMarkdown 调用强制
 * `name = existingMd.name ?? slug`,与 dirName 严格相等;assertSkillNameConsistency
 * 的 invariant 由本 RPC 路径主动维护。要改 slug 用 deleteSkill + saveAsSkill。
 */
export interface UpdateSkillMetadataPatch {
    description?: string;
    taskName?: string;
    preconditions?: unknown;
    steps?: unknown;
    expectedResult?: string;
    confidence?: number;
}
export type UpdateSkillMetadataResult = {
    kind: "ok";
    detail: SkillDetail;
} | {
    kind: "not-found";
} | {
    kind: "invalid";
    errors: string[];
};
export declare function updateSkillMetadata(api: OpenClawPluginApi, slug: string, patch: UpdateSkillMetadataPatch): Promise<UpdateSkillMetadataResult>;
//# sourceMappingURL=task-template-store.d.ts.map