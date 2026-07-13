export declare const AUTO_INDEX_BEGIN = "<!-- BEGIN AUTO-INDEX -->";
export declare const AUTO_INDEX_END = "<!-- END AUTO-INDEX -->";
export declare const TEMPLATE_VERSION = 5;
export declare const VTP_RECORDING_INDEX_TEMPLATE = "---\nname: vtp-recording\ndescription: \u7528\u6237\u5C4F\u5E55\u5F55\u5236\u751F\u6210\u7684\u53EF\u6267\u884C\u4EFB\u52A1\u96C6\u5408\u3002\u89E6\u53D1\u8BCD\uFF1A\u6211\u4E4B\u524D\u5F55\u8FC7\u7684\u3001\u91CD\u653E\u5F55\u5236\u3001\u5DF2\u5F55\u4EFB\u52A1\u3001\u6309\u4E4B\u524D\u5F55\u7684\u6B65\u9AA4\nmetadata:\n  openclaw:\n    skillKey: vtp-recording\ntemplate_version: 5\n---\n\n# VTP \u5F55\u5236 Skill \u5E93\n\n## \u5F3A\u5236\u6D41\u7A0B\n\n\u5F53\u7528\u6237\u8981\u6C42\u6267\u884C/\u91CD\u653E/\u590D\u76D8\u4E4B\u524D\u5F55\u8FC7\u7684\u4EFB\u52A1\u65F6\uFF1A\n\n1. \u5728\u4E0B\u65B9\u300C\u5DF2\u5F55\u5236\u4EFB\u52A1\u7D22\u5F15\u300D\u4E2D\u5339\u914D description \u6216 taskName \u6700\u8D34\u5408\u7528\u6237\u610F\u56FE\u7684\u5F55\u5236\n2. \u8BFB\u53D6\u8BE5\u5F55\u5236\u76EE\u5F55\u4E0B\u7684 `SKILL.md` \u62FF\u5230\u5B8C\u6574\u6B65\u9AA4\u540E\uFF0C**\u6309\u81EA\u7136\u8BED\u8A00\u76F4\u63A5\u6267\u884C**\u2014\u2014\n   \u6839\u636E\u6BCF\u6B65\u7684\u8BED\u4E49\u81EA\u884C\u6311\u9009\u5408\u9002\u7684\u5DE5\u5177\u4E00\u6B65\u6B65\u5B8C\u6210\uFF08\u5177\u4F53\u5DE5\u5177\u4E0D\u5728\u672C\u6A21\u677F\u4E2D\u9884\u8BBE\uFF09\n3. \u627E\u4E0D\u5230\u5339\u914D\u6216\u5339\u914D\u591A\u6761\u65F6\uFF0C\u660E\u786E\u544A\u8BC9\u7528\u6237\u300C\u672A\u627E\u5230 / \u6709\u591A\u4E2A\u5019\u9009\u300D\uFF0C\u8BA9\u5176\u6362\u66F4\u7CBE\u786E\u7684\u63CF\u8FF0\n4. **\u4E0D\u8981**\u865A\u6784\u6CA1\u5728\u7D22\u5F15\u4E2D\u7684\u5F55\u5236\n\n> \u7528\u6237\u4E5F\u53EF\u4EE5\u76F4\u63A5\u70B9\u51FB\u5217\u8868 UI \u7684\u300C\uD83D\uDCAC \u5728\u804A\u5929\u91CC\u8FD0\u884C\u300D\u6309\u94AE\u2014\u2014\u524D\u7AEF\u4F1A\u8C03\u7528\n> `arkclawVtpRecording.renderInstruction` \u53D6\u5F97\u81EA\u7136\u8BED\u8A00\u6307\u4EE4\u5E76\u7C98\u8D34\u5230\u5BF9\u8BDD\u6846\uFF1B\n> \u4F60\uFF08host \u6A21\u578B\uFF09\u6309\u6536\u5230\u7684\u6307\u4EE4\u6587\u672C\u9A71\u52A8\u5DE5\u5177\u5373\u53EF\uFF0C\u6574\u6761\u94FE\u8DEF\u65E0 slash \u547D\u4EE4\u3002\n\n## \u5DF2\u5F55\u5236\u4EFB\u52A1\u7D22\u5F15\n\n<!-- BEGIN AUTO-INDEX -->\n\u6682\u65E0\u5DF2\u5F55\u5236\u4EFB\u52A1\u3002\n<!-- END AUTO-INDEX -->\n\n## \u7ED3\u6784\u8BF4\u660E\n\n\u6BCF\u4E2A `reference/<slug>/` \u4E0B\uFF1A\n- `SKILL.md`\uFF1A\u4EFB\u52A1\u6B65\u9AA4\uFF08\u7ED9\u6A21\u578B\u8BFB\uFF09\n- `meta.json`\uFF1A\u751F\u6210\u5143\u6570\u636E\uFF08recordingId / createdAt / durationSec / resolution\uFF09\n- `prompt.json`\uFF1A\u539F\u59CB\u89C6\u9891\u5206\u6790\u4EA7\u7269\uFF0C\u65B9\u4FBF\u8FFD\u6EAF\n";
/**
 * Rebuild the vtp-recording top-level SKILL.md AUTO-INDEX block from the
 * current reference/* directories. Best-effort — caller wraps in try/catch +
 * logger.warn so failure does NOT block saveAsSkill main flow.
 *
 * Idempotent: produces the same output for the same on-disk state. Last
 * writer wins under concurrent saves (atomicWriteFileWithSync handles file
 * integrity; downstream LRU / next save will re-trigger rebuild and self-heal).
 */
/**
 * Rebuild result returned by rebuildCuaRecordingIndex.
 * slugCount: number of reference/<slug>/ directories that were indexed (0 when
 * the workspace has no saved recordings yet). Used by skill-index-scheduler to
 * record the vtp.skill_index.entry_count histogram with the real value.
 * changed: true once an index is (re)written; false only when the workspace
 * has no index and no reference dir yet (rebuild is a no-op).
 */
export interface RebuildIndexResult {
    slugCount: number;
    changed: boolean;
}
export declare function rebuildCuaRecordingIndex(cuaRecordingDir: string): Promise<RebuildIndexResult>;
/**
 * On-disk reference skill entry — populated by scanning the reference/<slug>/
 * directories' meta.json + prompt.json files concurrently. Consumed by
 * the task-template listing path to surface saved skills that may have been
 * cleaned out of state.json (e.g. by cleanup-scheduler retention sweep) but
 * persist on disk.
 *
 * Date format: createdAt is ISO 8601 string ("2026-04-28T03:11:15.545Z"),
 * mirrors the meta.json field directly. durationSec is seconds (number),
 * sizeBytes is bytes (number). Nullable fields use null (not undefined) so the
 * shape is JSON-stable and the front-end can render placeholder UI without
 * distinguishing missing vs. empty.
 */
export interface ReferenceSkillEntry {
    slug: string;
    recordingId: string;
    taskName: string | null;
    description: string | null;
    expectedResult: string | null;
    confidence: number | null;
    createdAt: string | null;
    durationSec: number | null;
    sizeBytes: number | null;
    resolution: string | null;
    promptDir: string;
}
/**
 * Scan reference/<slug>/ directories under refDir; for each safe slug read
 * meta.json + prompt.json concurrently and return a flat list. Historical
 * helper retained for reference-skill indexing after the recording-domain list
 * RPC was removed.
 *
 * Failure handling:
 *   - refDir missing or unreadable → returns []
 *   - slug not allowlisted (`isSafeSlug`) → skip
 *   - slug is a symlink or non-directory → skip (path traversal defence —
 *     readdir's Dirent.isDirectory() may follow symlinks on some platforms,
 *     so re-check with lstat)
 *   - meta.json missing or unparseable → skip (entry lacks recordingId)
 *   - prompt.json missing → entry retained with null prompt fields
 *
 * Concurrency: per-slug reads are Promise.all'd; the outer readdir is a single
 * read. Typical 100-slug LRU cap → ~200 concurrent fs.readFile calls, well
 * within Node's default fd pool.
 */
export declare function listReferenceSkills(refDir: string): Promise<ReferenceSkillEntry[]>;
//# sourceMappingURL=recording-index.d.ts.map