// vtp-recording top-level SKILL.md template + AUTO-INDEX rebuild logic.
//
// Extracted from skill-persistence.ts (R-Santa P3b) so:
//  - skill-persistence.ts stays under 800-line cap
//  - template upgrade + AUTO-INDEX splice is isolated for focused review
//  - the SKILL.md template version bump path has one obvious file to touch
//
// Public surface stays stable: skill-persistence.ts re-exports the 5 names
// below so existing importers (commands.ts / cleanup-scheduler.ts / tests)
// don't need path changes.
import fs from "node:fs/promises";
import path from "node:path";
// R-Santa W8: shared atomic write helper from helpers.ts (was previously
// inlined here for "acyclic dep graph"; helpers.ts is a leaf utility module
// with no imports of recording-index, so the graph stays acyclic).
import { atomicWriteFileWithSync } from "./helpers.js";
// V6.4 post-review fix: Intl.Segmenter 模块级复用(避免每次 sanitizeIndexTaskName 都新建)
const GRAPHEME_SEGMENTER = new Intl.Segmenter("zh-Hans", { granularity: "grapheme" });
// AUTO-INDEX markers: rebuilder splices the live reference/* slug list
// between these markers; text outside markers is preserved (users can add
// custom guidance freely).
export const AUTO_INDEX_BEGIN = "<!-- BEGIN AUTO-INDEX -->";
export const AUTO_INDEX_END = "<!-- END AUTO-INDEX -->";
// #3 (SKILL.md template upgrade mechanism): bumped on every breaking template
// change. rebuildCuaRecordingIndex compares the on-disk SKILL.md frontmatter's
// `template_version` against this constant; older / missing → backup current
// SKILL.md to `.user-backup-<ts>.md` and re-seed from VTP_RECORDING_INDEX_TEMPLATE
// (then splice the live AUTO-INDEX block in). User customizations outside the
// AUTO-INDEX markers are PRESERVED in the backup file but NOT auto-merged —
// admin reviews the backup and re-applies if desired.
//
// Bump this whenever:
//  - "强制流程" / "调用示例" / "结构说明" wording changes meaningfully
//  - frontmatter shape changes (new metadata.* keys, name/description rename)
//  - AUTO-INDEX marker semantics change
// DO NOT bump for cosmetic edits (whitespace, typo fixes that don't change
// LLM behavior) — every bump triggers a backup file on every install.
//
// v3: dropped "/vtp-recording execute <…>" guidance (the slash subcommand
// no longer exists). Saved skills are now invoked via the front-end "💬
// 在聊天里运行" button → arkclawVtpRecording.renderInstruction → paste the
// returned instruction text into chat → host model dispatches naturally.
// v4: removed the "浏览器 / 桌面自动化 / 文件操作 / CUA 等" tool enumeration
// from the 强制流程 step 2. Listing CUA by name biased host model toward
// CUA when other tools (BUA, file ops, system scripts) might fit better.
// New wording is fully tool-agnostic — host model picks the right tool
// based on step semantics, not template hints.
// v5 (V6.4): AUTO-INDEX 加 taskName + 行格式改为
// `- <taskName>(slug=<slug>) — <description>`, 不兼容 v4 (host LLM 若按
// v4 格式 parse 会读不到 taskName)。bump 触发现网备份重生成。
export const TEMPLATE_VERSION = 5;
// Auto-generated vtp-recording top-level SKILL.md. The AUTO-INDEX block is
// rebuilt on every saveAsSkill / LRU prune / hourly maintenance pass so the
// LLM system-prompt contains the live reference catalog.
export const VTP_RECORDING_INDEX_TEMPLATE = `---
name: vtp-recording
description: 用户屏幕录制生成的可执行任务集合。触发词：我之前录过的、重放录制、已录任务、按之前录的步骤
metadata:
  openclaw:
    skillKey: vtp-recording
template_version: 5
---

# VTP 录制 Skill 库

## 强制流程

当用户要求执行/重放/复盘之前录过的任务时：

1. 在下方「已录制任务索引」中匹配 description 或 taskName 最贴合用户意图的录制
2. 读取该录制目录下的 \`SKILL.md\` 拿到完整步骤后，**按自然语言直接执行**——
   根据每步的语义自行挑选合适的工具一步步完成（具体工具不在本模板中预设）
3. 找不到匹配或匹配多条时，明确告诉用户「未找到 / 有多个候选」，让其换更精确的描述
4. **不要**虚构没在索引中的录制

> 用户也可以直接点击列表 UI 的「💬 在聊天里运行」按钮——前端会调用
> \`arkclawVtpRecording.renderInstruction\` 取得自然语言指令并粘贴到对话框；
> 你（host 模型）按收到的指令文本驱动工具即可，整条链路无 slash 命令。

## 已录制任务索引

${AUTO_INDEX_BEGIN}
暂无已录制任务。
${AUTO_INDEX_END}

## 结构说明

每个 \`reference/<slug>/\` 下：
- \`SKILL.md\`：任务步骤（给模型读）
- \`meta.json\`：生成元数据（recordingId / createdAt / durationSec / resolution）
- \`prompt.json\`：原始视频分析产物，方便追溯
`;
export async function rebuildCuaRecordingIndex(cuaRecordingDir) {
    const refDir = path.join(cuaRecordingDir, "reference");
    const indexPath = path.join(cuaRecordingDir, "SKILL.md");
    // Skip if there's no on-disk evidence (no existing index, no reference dir).
    // Prevents background maintenance from seeding an empty placeholder into a
    // workspace that's never had a recording saved (e.g. host startup sweep
    // touching a fresh test fixture or an operator who hasn't used the feature).
    let hasIndex = false;
    let hasRefDir = false;
    try {
        await fs.access(indexPath);
        hasIndex = true;
    }
    catch {
        /* ignore */
    }
    try {
        await fs.access(refDir);
        hasRefDir = true;
    }
    catch {
        /* ignore */
    }
    if (!hasIndex && !hasRefDir)
        return { slugCount: 0, changed: false };
    let slugs = [];
    try {
        const dirents = await fs.readdir(refDir, { withFileTypes: true });
        // V6.4 post-review fix-O + AIME-3: 两层防御
        //   1. isSafeSlug 过滤 — 拒绝 .hidden / 空格 / 控制字符 / 路径分隔符
        //      (对齐 listReferenceSkills + task-template-store 单一来源)
        //   2. lstat 校验 — Dirent.isDirectory() 在某些平台跟随 symlink,
        //      必须 lstat 显式拒 symlink (AIME-3 第 1 层防御: 目录级 symlink TOCTOU)
        const safe = [];
        for (const d of dirents) {
            if (!isSafeSlug(d.name))
                continue;
            try {
                const st = await fs.lstat(path.join(refDir, d.name));
                if (!st.isDirectory() || st.isSymbolicLink())
                    continue;
            }
            catch {
                continue;
            }
            safe.push(d.name);
        }
        slugs = safe.sort();
    }
    catch {
        // reference/ missing or unreadable — render an empty index placeholder
        slugs = [];
    }
    const entries = [];
    for (const slug of slugs) {
        const skillPath = path.join(refDir, slug, "SKILL.md");
        const promptPath = path.join(refDir, slug, "prompt.json");
        // V6.4 post-review fix-AIME-3 第 2/3 层: safeReadFile 拒绝跟随
        // 文件级 symlink (SKILL.md / prompt.json 本身被替换为指向 workspace
        // 外敏感文件的 symlink)
        const markdown = await safeReadFile(skillPath);
        if (markdown === null) {
            // SKILL.md missing / symlink / hardlink / unreadable — skip entry
            continue;
        }
        const description = extractFrontmatterDescription(markdown) ?? "无描述";
        // V6.4: 读 prompt.json 拿 taskName (best-effort; 缺失则 taskName=null,
        // 渲染 fallback 到 <slug>)。新增 ~100 次 fs.readFile (LRU 上限内), 性能可接受。
        let taskName = null;
        const raw = await safeReadFile(promptPath);
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed.taskName === "string" && parsed.taskName.length > 0) {
                    taskName = parsed.taskName;
                }
            }
            catch {
                // prompt.json 解析失败 — taskName 保持 null
            }
        }
        entries.push({
            slug,
            description: sanitizeIndexDescription(description),
            taskName,
        });
    }
    const renderedBlock = renderCuaRecordingAutoIndex(entries);
    let existing;
    try {
        existing = await fs.readFile(indexPath, "utf8");
        // #3 template_version 升级机制：on-disk SKILL.md 落后于 TEMPLATE_VERSION
        // → 备份当前内容到 .user-backup-<ts>.md，用最新模板替换。AUTO-INDEX 块
        // 仍然走下面的 splice 路径，所以已录制任务索引不丢。用户自定义文字
        // 保留在备份文件，需要 manual merge（不自动合并以免冲突）。
        const existingVersion = extractFrontmatterTemplateVersion(existing);
        if (existingVersion === null || existingVersion < TEMPLATE_VERSION) {
            const backupPath = path.join(cuaRecordingDir, `SKILL.md.user-backup-${Date.now()}.md`);
            // Codex audit Medium-③: do NOT proceed with template overwrite if
            // backup fails — silently swallowing the error = guaranteed user data
            // loss when permissions / disk-full / FS error hits. Throw instead so
            // the caller (handleSaveAsSkill) catches + logger.warns + leaves the
            // existing SKILL.md untouched (next saveAsSkill retries the upgrade).
            await atomicWriteFileWithSync(backupPath, existing);
            existing = VTP_RECORDING_INDEX_TEMPLATE;
        }
    }
    catch (readErr) {
        // First-time write or unreadable file. fs.readFile fails with ENOENT for
        // first-time, surface other errors so caller's logger.warn captures them.
        if (typeof readErr?.code === "string" &&
            readErr.code !== "ENOENT") {
            // EACCES / EISDIR / etc. — propagate so caller's catch logs the cause.
            // Backup throw above is the same "fail loud" rationale.
            throw readErr;
        }
        await fs.mkdir(cuaRecordingDir, { recursive: true });
        existing = VTP_RECORDING_INDEX_TEMPLATE;
    }
    const next = replaceAutoIndexBlock(existing, renderedBlock);
    const final = next.endsWith("\n") ? next : `${next}\n`;
    await atomicWriteFileWithSync(indexPath, final);
    return { slugCount: entries.length, changed: true };
}
/**
 * Extract `template_version: <int>` from a SKILL.md YAML frontmatter block.
 * Returns null if frontmatter missing, field absent, or value is not a
 * positive integer (caller treats null as "needs upgrade", same as v0/v1
 * legacy files).
 */
function extractFrontmatterTemplateVersion(markdown) {
    if (!markdown.startsWith("---"))
        return null;
    const closeMatch = /\r?\n---/.exec(markdown.slice(3));
    if (!closeMatch)
        return null;
    const fm = markdown.slice(3, closeMatch.index + 3);
    // Anchor regex to line start so a string-valued field that happens to
    // contain "template_version: 9" (e.g. inside a description) doesn't trick
    // the version reader.
    const m = /^[ \t]*template_version[ \t]*:[ \t]*(\d+)\s*$/m.exec(fm);
    if (!m)
        return null;
    const v = Number.parseInt(m[1], 10);
    return Number.isFinite(v) && v >= 0 ? v : null;
}
function renderCuaRecordingAutoIndex(entries) {
    if (entries.length === 0) {
        return `${AUTO_INDEX_BEGIN}\n暂无已录制任务。\n${AUTO_INDEX_END}`;
    }
    // V6.4 spec §4.3: 行格式 `- <taskName>(slug=<slug>) — <description>`
    // taskName=null 时 fallback 为 `<slug>` (视觉与旧格式保持一致)。
    const lines = entries.map((e) => {
        const displayName = e.taskName ? sanitizeIndexTaskName(e.taskName) : e.slug;
        return `- ${displayName}(slug=${e.slug}) — ${e.description}`;
    });
    return `${AUTO_INDEX_BEGIN}\n${lines.join("\n")}\n${AUTO_INDEX_END}`;
}
/**
 * Extract `description` from a SKILL.md YAML frontmatter block. Returns null
 * if no frontmatter, no description field, or empty value. Tolerates JSON-style
 * quoted strings ("..." / '...') and falls back to the unquoted raw value when
 * JSON.parse fails (e.g. unterminated quote — caller substitutes "无描述").
 */
function extractFrontmatterDescription(markdown) {
    if (!markdown.startsWith("---"))
        return null;
    const closeMatch = /\r?\n---/.exec(markdown.slice(3));
    if (!closeMatch)
        return null;
    const fm = markdown.slice(3, closeMatch.index + 3);
    const line = fm.split(/\r?\n/).find((l) => /^\s*description\s*:/.test(l));
    if (!line)
        return null;
    const raw = line.replace(/^\s*description\s*:\s*/, "").trim();
    if (!raw)
        return null;
    if ((raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
        (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)) {
        try {
            const normalised = raw.startsWith("'")
                ? `"${raw.slice(1, -1).replace(/"/g, '\\"')}"`
                : raw;
            return JSON.parse(normalised);
        }
        catch {
            return raw.slice(1, -1);
        }
    }
    return raw.replace(/^["']|["']$/g, "");
}
/**
 * Sanitise a description for safe inclusion in a markdown bullet line.
 * - Collapse newlines/tabs into a single space so multi-line values can't
 *   break the list rendering
 * - Escape characters that could corrupt the bullet (`]` `(` `<` `>` `\`) —
 *   defensive for future automated description sources
 * - Truncate to 200 chars; the index is a navigation aid, not a doc
 */
function sanitizeIndexDescription(input) {
    const collapsed = input.replace(/[\r\n\t]+/g, " ").trim();
    const escaped = collapsed
        .replace(/\\/g, "\\\\")
        .replace(/\]/g, "\\]")
        .replace(/\(/g, "\\(")
        .replace(/</g, "\\<")
        .replace(/>/g, "\\>");
    return escaped.length > 200 ? `${escaped.slice(0, 197)}...` : escaped;
}
/**
 * V6.4 spec §4.3: AUTO-INDEX 行内 taskName sanitize。
 * 与 description 规则的差异:
 *  - ( ) → 全角（）防止破坏 `- <taskName>(slug=...) — <desc>` 行格式 parse
 *  - markdown 转义 (] < > \\) 与 description 同
 *  - grapheme-safe cap 80 (与 renderTriggerSentence 同标准)
 */
function sanitizeIndexTaskName(input) {
    if (!input)
        return "";
    // V6.4 post-review D fix: /\s+/gu 覆盖 Unicode 全集 whitespace (NBSP/IDS/LS/PS 等)。
    const collapsed = input.replace(/\s+/gu, " ").trim();
    if (!collapsed)
        return "";
    // ( ) → 全角（）避免与 (slug=...) 段冲突
    const escapedParens = collapsed.replace(/\(/g, "（").replace(/\)/g, "）");
    // markdown 转义复用 description 规则 (] < > \\)
    const escapedMd = escapedParens
        .replace(/\\/g, "\\\\")
        .replace(/\]/g, "\\]")
        .replace(/</g, "\\<")
        .replace(/>/g, "\\>");
    // V6.4 post-review C fix: cap 80 grapheme — 保留 1 grapheme 给省略号,
    // 总长(含 …)严格 ≤ 80,与 truncateByGrapheme 行为对齐。
    const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(escapedMd), (s) => s.segment);
    if (graphemes.length <= 80)
        return escapedMd;
    return graphemes.slice(0, 79).join("") + "…";
}
/**
 * Splice `renderedBlock` between the AUTO-INDEX markers in `existing`. If the
 * markers are absent (legacy file authored before this change), append a new
 * "已录制任务索引" section at the end so existing user-customised text is
 * preserved.
 */
function replaceAutoIndexBlock(existing, renderedBlock) {
    const begin = existing.indexOf(AUTO_INDEX_BEGIN);
    const end = existing.indexOf(AUTO_INDEX_END);
    if (begin >= 0 && end > begin) {
        return [
            existing.slice(0, begin),
            renderedBlock,
            existing.slice(end + AUTO_INDEX_END.length),
        ].join("");
    }
    return `${existing.trimEnd()}\n\n## 已录制任务索引\n\n${renderedBlock}\n`;
}
// Slug allowlist mirrors prompt-rendering.ts:isSafeReferenceSlug — strict Unicode
// letters/numbers/hyphen. Refuses ".hidden", whitespace, control chars, and
// path separators (any shape slugifySkillName would never produce).
function isSafeSlug(slug) {
    return /^[\p{L}\p{N}-]+$/u.test(slug);
}
// V6.4 post-review fix-AIME-3: safeReadFile 三重 guard 防 symlink TOCTOU
//   - !st.isSymbolicLink() — 拒文件级 symlink (rebuild loop 用)
//   - st.isFile() — 拒目录/管道/socket 等非常规文件
//   - st.nlink === 1 — 拒 hard link attack (attacker hard-link 受害文件到
//     reference/<slug>/prompt.json,读出来会写进 AUTO-INDEX 索引泄漏)
async function safeReadFile(filePath) {
    try {
        const st = await fs.lstat(filePath);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)
            return null;
        return await fs.readFile(filePath, "utf8");
    }
    catch {
        return null;
    }
}
async function readJson(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
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
export async function listReferenceSkills(refDir) {
    let dirents = [];
    try {
        dirents = await fs.readdir(refDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const slugs = [];
    for (const d of dirents) {
        if (!isSafeSlug(d.name))
            continue;
        try {
            const st = await fs.lstat(path.join(refDir, d.name));
            if (!st.isDirectory() || st.isSymbolicLink())
                continue;
        }
        catch {
            continue;
        }
        slugs.push(d.name);
    }
    const entries = await Promise.all(slugs.map(async (slug) => {
        const slugDir = path.join(refDir, slug);
        const [meta, prompt] = await Promise.all([
            readJson(path.join(slugDir, "meta.json")),
            readJson(path.join(slugDir, "prompt.json")),
        ]);
        if (!meta ||
            typeof meta.recordingId !== "string" ||
            meta.recordingId.length === 0) {
            return null;
        }
        const taskName = typeof prompt?.taskName === "string" && prompt.taskName.length > 0
            ? prompt.taskName
            : null;
        const description = typeof prompt?.description === "string" && prompt.description.length > 0
            ? prompt.description
            : null;
        const expectedResult = typeof prompt?.expectedResult === "string" &&
            prompt.expectedResult.length > 0
            ? prompt.expectedResult
            : null;
        const confidence = typeof prompt?.confidence === "number" &&
            Number.isFinite(prompt.confidence) &&
            prompt.confidence >= 0 &&
            prompt.confidence <= 1
            ? prompt.confidence
            : null;
        return {
            slug,
            recordingId: meta.recordingId,
            taskName,
            description,
            expectedResult,
            confidence,
            createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
            durationSec: typeof meta.durationSec === "number" ? meta.durationSec : null,
            sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : null,
            resolution: typeof meta.resolution === "string" ? meta.resolution : null,
            promptDir: slugDir,
        };
    }));
    return entries.filter((e) => e !== null);
}
//# sourceMappingURL=recording-index.js.map