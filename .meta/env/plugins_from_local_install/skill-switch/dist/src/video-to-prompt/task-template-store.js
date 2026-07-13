// 二期 F-B：任务模板域读侧 helper（D-20 双域解耦）。
//
// 这一组函数不读 state.recordings、不依赖 plugin/runtime 状态，纯磁盘扫描
// reference/<slug>/ 目录：
//   - listAllSkills(refDir)：扫所有 slug → SkillView[]
//   - readSkillDetail(refDir, slug)：单个 slug → SkillDetail（含 prompt）
//   - deleteSavedSkill(refDir, slug)：物理删 reference/<slug>/（不动 runs/）
//   - updateSkillMetadata(refDir, slug, patch)：改单个 slug 的元数据
//   - resolveReferenceDir(api)：拿 reference/ 绝对路径
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readSkillsConfig } from "./helpers.js";
import { resolveWorkspaceDir } from "./workspace.js";
import { safeRecursiveRm } from "./cleanup-scheduler.js";
import { normalizePromptEdit, validatePromptShape, SKILL_EDITABLE_PROMPT_KEYS, } from "./prompt-normalize.js";
import { renderSkillMarkdown } from "./skill-persistence.js";
import { rebuildCuaRecordingIndex } from "./recording-index.js";
/**
 * Resolve <workspace>/<vtpRecordingRoot>/reference/.
 */
export function resolveReferenceDir(api) {
    const workspace = resolveWorkspaceDir(api);
    const cfg = readSkillsConfig(api);
    return path.join(workspace, cfg.vtpRecordingRoot, "reference");
}
async function readJson(file) {
    try {
        const raw = await fs.readFile(file, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function isSafeSlug(slug) {
    return /^[\p{L}\p{N}-]+$/u.test(slug);
}
async function resolveSafeReferenceSlugDir(refDir, slug) {
    if (!slug || !isSafeSlug(slug))
        return null;
    const slugDir = path.join(refDir, slug);
    try {
        const st = await fs.lstat(slugDir);
        if (!st.isDirectory() || st.isSymbolicLink())
            return null;
        const realSlugDir = await fs.realpath(slugDir);
        return { slugDir, realSlugDir, dev: st.dev, ino: st.ino };
    }
    catch {
        return null;
    }
}
async function isSameSafeReferenceSlugDir(safe) {
    try {
        const st = await fs.lstat(safe.slugDir);
        return (st.isDirectory() &&
            !st.isSymbolicLink() &&
            st.dev === safe.dev &&
            st.ino === safe.ino);
    }
    catch {
        return false;
    }
}
async function regularFileIdentity(file) {
    try {
        const st = await fs.lstat(file);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1)
            return null;
        return { dev: st.dev, ino: st.ino };
    }
    catch {
        return null;
    }
}
/**
 * V6.2 NEW-M2: atomic-replace via tmp+rename (P-04 收敛).
 *
 * 历史实现是 `open(O_WRONLY) + truncate(0) + writeFile + fsync` 的 in-place
 * 改写 — 不是原子,crash 在 truncate 与 writeFile 之间会留下空 / 半截文件。
 * 改 tmp+rename 后:
 *   1) lstat 校验 target 仍是预期文件 (inode + dev + nlink === 1 拒 hardlink
 *      或 symlink victim)
 *   2) 在 target 同目录写 tmp 文件 (O_EXCL+O_NOFOLLOW+0600, 防 symlink 攻击)
 *   3) writeFile + fsync tmp,然后 close
 *   4) rename 前再次 lstat target 校验未被替换 (TOCTOU 二次检查)
 *   5) atomic rename(tmp, target) — POSIX 保证同 FS rename 原子;target dentry
 *      指向新 inode,外部 hardlink victim 不受影响 (我们写的是新文件,旧
 *      inode 仍可被外部 hardlink 引用,但其内容也未被我们碰过)
 *
 * hardlink 防御保留:step 1/4 的 lstat + nlink !== 1 检查仍然拒 hardlink target
 * (T16/T17 行为不变);同时 tmp+rename 自身让 hardlink victim 无法被改 (rename
 * 替换 dentry 不改 victim inode 内容)。
 *
 * 失败时 tmp 文件被清理 (finally unlink). 成功后 tmp 已被 rename 消费,无残留。
 */
async function overwriteSameRegularFileWithSync(file, expected, data) {
    // Step 1: 校验 target 仍是预期 (拒 hardlink + symlink + 异 inode)
    try {
        const st = await fs.lstat(file);
        if (st.isSymbolicLink() ||
            !st.isFile() ||
            st.nlink !== 1 ||
            st.dev !== expected.dev ||
            st.ino !== expected.ino) {
            return false;
        }
    }
    catch {
        return false;
    }
    // Step 2-3: 写 tmp 文件 (O_EXCL 防 race,O_NOFOLLOW 防 symlink,0600 防 ACL 泄漏)
    const tmp = `${file}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    let handle;
    try {
        handle = await fs.open(tmp, constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(data, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        // Step 4: rename 前再次 lstat target — 防 race 把 target 换成 hardlink
        try {
            const st2 = await fs.lstat(file);
            if (st2.isSymbolicLink() ||
                !st2.isFile() ||
                st2.nlink !== 1 ||
                st2.dev !== expected.dev ||
                st2.ino !== expected.ino) {
                return false;
            }
        }
        catch {
            return false;
        }
        // Step 5: atomic rename
        await fs.rename(tmp, file);
        return true;
    }
    catch {
        return false;
    }
    finally {
        await handle?.close().catch(() => { });
        // Cleanup tmp 若仍存在 (失败路径或 rename 未消费)
        await fs.unlink(tmp).catch(() => { });
    }
}
/**
 * L3: updatedAt = SKILL.md 的 mtime。updateSkillMetadata 每次改名/改描述都
 * 重写 SKILL.md,故其 mtime 即真实最后更新时间;从未改过的模板 mtime≈createdAt。
 * stat 失败 → 回退 createdAt。
 */
async function skillUpdatedAt(slugDir, createdAt) {
    try {
        const st = await fs.lstat(path.join(slugDir, "SKILL.md"));
        return st.mtime.toISOString();
    }
    catch {
        return createdAt;
    }
}
async function readSkillMdFields(skillDir) {
    let raw;
    try {
        raw = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    }
    catch {
        return { name: null, description: null };
    }
    const fmEndMatch = /\r?\n---/.exec(raw.slice(4));
    const fmEnd = fmEndMatch ? fmEndMatch.index + 4 : -1;
    const fm = fmEnd > 0 ? raw.slice(0, fmEnd) : "";
    // I-1: name 解析镜像 description — JSON.stringify 写入的双引号值需配套
    // quoted 分支 + \" un-escape,否则含内嵌引号的 name 会被 [^"]+? 截断。
    const quotedName = /\r?\n\s*name:\s*"((?:\\.|[^"\\])*)"\s*(?:\r?\n|$)/.exec(fm);
    const unquotedName = /\r?\n\s*name:\s*([^"\r\n][^\r\n]*?)\s*(?:\r?\n|$)/.exec(fm);
    const nameRaw = quotedName
        ? quotedName[1]
        : unquotedName
            ? unquotedName[1]
            : null;
    const quotedDesc = /\r?\n\s*description:\s*"((?:\\.|[^"\\])*)"\s*(?:\r?\n|$)/.exec(fm);
    const unquotedDesc = /\r?\n\s*description:\s*([^"\r\n][^\r\n]*?)\s*(?:\r?\n|$)/.exec(fm);
    const description = quotedDesc
        ? quotedDesc[1]
        : unquotedDesc
            ? unquotedDesc[1]
            : null;
    return {
        name: nameRaw ? nameRaw.replace(/\\"/g, '"').trim() : null,
        description: description ? description.replace(/\\"/g, '"') : null,
    };
}
export async function listAllSkills(refDir, opts) {
    let dirents = [];
    try {
        dirents = await fs.readdir(refDir, { withFileTypes: true });
    }
    catch {
        return { skills: [], total: 0 };
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
    const all = await Promise.all(slugs.map(async (slug) => {
        const slugDir = path.join(refDir, slug);
        const [meta, prompt, mdFields] = await Promise.all([
            readJson(path.join(slugDir, "meta.json")),
            readJson(path.join(slugDir, "prompt.json")),
            readSkillMdFields(slugDir),
        ]);
        if (!meta || typeof meta.recordingId !== "string" || !meta.recordingId) {
            return null;
        }
        const description = typeof prompt?.description === "string" && prompt.description
            ? prompt.description
            : (mdFields.description ?? "");
        const createdAt = typeof meta.createdAt === "string" ? meta.createdAt : "";
        // 与 readSkillDetail 对齐 (line 367-370): SkillView.name 优先取
        // prompt.taskName (业务任务名); SKILL.md frontmatter name 按设计
        // 恒等于 slug (见 updateSkillMetadata C-1 注释 + T12 回归), 不能
        // 作为前端展示的"任务名称"。
        const taskName = typeof prompt?.taskName === "string" && prompt.taskName
            ? prompt.taskName
            : (mdFields.name ?? slug);
        return {
            slug,
            name: taskName,
            description,
            createdAt,
            updatedAt: await skillUpdatedAt(slugDir, createdAt),
            sourceRecordingId: meta.recordingId,
        };
    }));
    let filtered = all.filter((v) => v !== null);
    if (opts?.q && opts.q.trim()) {
        const q = opts.q.trim().toLowerCase();
        const tokens = q.split(/\s+/).filter(Boolean);
        filtered = filtered.filter((s) => {
            const hay = `${s.name} ${s.description}`.toLowerCase();
            return tokens.every((tok) => hay.includes(tok));
        });
    }
    // 「执行次数」维度移除后,列表按 createdAt 倒序(最新建的在前)。
    filtered.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    const total = filtered.length;
    const offset = Math.max(0, opts?.offset ?? 0);
    const limit = Math.max(1, Math.min(opts?.limit ?? 20, 500));
    const skills = filtered.slice(offset, offset + limit);
    return { skills, total };
}
export async function readSkillDetail(api, slug) {
    const refDir = resolveReferenceDir(api);
    const safe = await resolveSafeReferenceSlugDir(refDir, slug);
    if (!safe)
        return null;
    const { slugDir } = safe;
    const [meta, prompt, mdFields] = await Promise.all([
        readJson(path.join(slugDir, "meta.json")),
        readJson(path.join(slugDir, "prompt.json")),
        readSkillMdFields(slugDir),
    ]);
    if (!meta || typeof meta.recordingId !== "string" || !meta.recordingId) {
        return null;
    }
    const taskName = typeof prompt?.taskName === "string" && prompt.taskName
        ? prompt.taskName
        : (mdFields.name ?? slug);
    const description = typeof prompt?.description === "string" && prompt.description
        ? prompt.description
        : (mdFields.description ?? "");
    const createdAt = typeof meta.createdAt === "string" ? meta.createdAt : "";
    const stepsArr = Array.isArray(prompt?.steps)
        ? (prompt?.steps).map((s, i) => ({
            ...s,
            // M3: index 必须在 ...s 之后 — 否则 step 对象自带的坏
            // index(如显式 index: undefined)会覆盖归一化好的值。
            index: typeof s.index === "number" ? s.index : i + 1,
        }))
        : [];
    // I-1 评审修正: 任务模板域 (getSkill) 不返回录制域信息。原
    // associatedVideoStatus 字段从源录制 relay-state.json 派生,既违反域纯净
    // 原则,又在源录制 7 天后被 cleanup 清掉 relay-state.json 时误报
    // keepVideoOnMount:false。需要视频关联信息的前端走录制域 RPC。
    return {
        slug,
        // SkillView.name 语义同 listAllSkills: 前端"任务名称"取 prompt.taskName,
        // 不是 SKILL.md frontmatter (后者按 C-1 设计 = slug)。const taskName 在
        // 上方 line 375 已计算 fallback 链 (prompt.taskName → mdFields.name → slug),
        // 顶层 name 和嵌套 prompt.taskName 共用同一值。
        name: taskName,
        description,
        createdAt,
        updatedAt: await skillUpdatedAt(slugDir, createdAt),
        sourceRecordingId: meta.recordingId,
        prompt: {
            taskName,
            ...(typeof prompt?.description === "string"
                ? { description: prompt.description }
                : {}),
            ...(Array.isArray(prompt?.preconditions)
                ? { preconditions: prompt.preconditions }
                : {}),
            steps: stepsArr,
            ...(typeof prompt?.expectedResult === "string"
                ? { expectedResult: prompt.expectedResult }
                : {}),
            ...(typeof prompt?.confidence === "number"
                ? { confidence: prompt.confidence }
                : {}),
            source: prompt?.source &&
                typeof prompt.source === "object" &&
                !Array.isArray(prompt.source)
                ? prompt.source
                : {},
            createdAt: typeof prompt?.createdAt === "string" ? prompt.createdAt : createdAt,
        },
    };
}
export async function deleteSavedSkill(refDir, slug) {
    const safe = await resolveSafeReferenceSlugDir(refDir, slug);
    if (!safe) {
        return { deleted: false, alreadyDeleted: true };
    }
    const rm = await safeRecursiveRm(safe.slugDir, {
        expectedRoot: { dev: safe.dev, ino: safe.ino },
    });
    if (!rm.removed && !rm.missing) {
        return {
            deleted: false,
            alreadyDeleted: false,
            deleteFailed: true,
            errors: rm.errors,
        };
    }
    return { deleted: true, alreadyDeleted: false };
}
export async function updateSkillMetadata(api, slug, patch) {
    const refDir = resolveReferenceDir(api);
    const safe = await resolveSafeReferenceSlugDir(refDir, slug);
    if (!safe)
        return { kind: "not-found" };
    const { realSlugDir } = safe;
    const skillMd = path.join(realSlugDir, "SKILL.md");
    const skillMdIdentity = await regularFileIdentity(skillMd);
    if (!skillMdIdentity)
        return { kind: "not-found" };
    // 读 meta.json — 重渲 SKILL.md 时取 sourceRecordingId / durationSec /
    // resolution / sizeBytes / createdAt,后者让 createdAt 跨编辑保持稳定
    // (renderSkillMarkdown 默认会用 new Date,会让 timeline 漂移)。
    const meta = await readJson(path.join(realSlugDir, "meta.json"));
    if (!meta || typeof meta.recordingId !== "string" || !meta.recordingId) {
        return { kind: "not-found" };
    }
    // 读 prompt.json + identity:模板若缺这个文件视为损坏,直接 not-found
    // (二期 saveAsSkill 之后所有 reference/<slug>/ 都会带 prompt.json)。
    const promptJsonPath = path.join(realSlugDir, "prompt.json");
    let promptIdentity;
    let existingPrompt;
    try {
        const st = await fs.lstat(promptJsonPath);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
            return { kind: "not-found" };
        }
        promptIdentity = { dev: st.dev, ino: st.ino };
        existingPrompt = JSON.parse(await fs.readFile(promptJsonPath, "utf8"));
    }
    catch {
        return { kind: "not-found" };
    }
    // 收集 prompt-body 编辑字段 (V6.2 I6.2-1: 用 SKILL_EDITABLE_PROMPT_KEYS
    // 单一 SoT,与 handler 的 promptDirty 检测同源);description 同时进 prompt.json
    // (5 块之一) 与 SKILL.md frontmatter (顶层 description),所以也算 promptDirty。
    const promptEditableInput = {};
    for (const k of SKILL_EDITABLE_PROMPT_KEYS) {
        if (patch[k] !== undefined) {
            promptEditableInput[k] = patch[k];
        }
    }
    const promptDirty = Object.keys(promptEditableInput).length > 0;
    // V6.2 I6.2-2: 把 existingMd 拉取移到 normalize 之前,与 existingPrompt 一起
    // 构造 enrichedExisting — taskName / description 缺 → 取 frontmatter fallback。
    // V6.1 时 handler 做 readSkillDetail baseline 拉取在 store re-read 之前形成
    // TOCTOU window;改在 store 内单次读 + 单次合并,window 缩小到 store 内两次
    // lstat 之间 (per-slug lock 是真正根治,标 TODO)。
    const existingMd = await readSkillMdFields(realSlugDir);
    if (!(await isSameSafeReferenceSlugDir(safe))) {
        return { kind: "not-found" };
    }
    // enrichedExisting: legacy schema 缺 taskName/description 时从 SKILL.md
    // frontmatter 补,与 readSkillDetail 的 fallback 逻辑等价。其它字段
    // (preconditions/steps/expectedResult/confidence) 缺仍由 validate 拒,errors
    // 指向真 missing,UI 可指引用户补齐。
    const enrichedExisting = {
        ...existingPrompt,
        ...(typeof existingPrompt.taskName === "string" &&
            existingPrompt.taskName
            ? {}
            : { taskName: existingMd.name ?? slug }),
        ...(typeof existingPrompt.description === "string" &&
            existingPrompt.description
            ? {}
            : { description: existingMd.description ?? "" }),
    };
    let nextPrompt = enrichedExisting;
    if (promptDirty) {
        nextPrompt = normalizePromptEdit(enrichedExisting, promptEditableInput);
        const errs = validatePromptShape(nextPrompt);
        if (errs.length > 0) {
            return { kind: "invalid", errors: errs };
        }
    }
    // C-1 (V6.1): finalName 强制 = existingMd.name ?? slug,与 dirName 严格
    // 一致 — 保 E-7 invariant (assertSkillNameConsistency 验的 dirName ===
    // frontmatter.name)。前端 "任务名称" 走 patch.taskName 不是 patch.name;
    // patch.name 字段已从 UpdateSkillMetadataPatch 删除,handler 也不解析。
    const finalName = existingMd.name ?? slug;
    // SKILL.md frontmatter description 优先取 patch.description,再 fallback
    // nextPrompt.description (可能由 normalizePromptEdit 写入),最后回落
    // existingMd.description。INDUSTRY-STANDARDS §4 must-fix #2:Anthropic
    // Skills frontmatter description ≤1024 char,超长截断 + 警告。
    const descSource = typeof patch.description === "string"
        ? patch.description
        : typeof nextPrompt.description === "string"
            ? nextPrompt.description
            : (existingMd.description ?? "");
    let finalDescription = descSource;
    if (finalDescription.length > 1024) {
        api.logger?.warn?.(`[vtp] updateSkillMetadata description truncated from ${finalDescription.length} to 1024 chars (Anthropic Skills spec).`);
        finalDescription = finalDescription.slice(0, 1021) + "...";
    }
    // 重渲 SKILL.md (替换原 in-place regex):body 段含 taskName /
    // description / preconditions / steps / expectedResult — 任何 prompt 字段
    // 变更都要重渲。createdAt 传 meta.json 中原值,避免每次编辑都重新打时
    // 间戳。硬约束 #26:admonition 块覆盖整个 body,trust boundary 自动保留。
    const renderedMd = renderSkillMarkdown({
        name: finalName,
        description: finalDescription,
        prompt: nextPrompt,
        sourceRecordingId: meta.recordingId,
        durationSec: typeof meta.durationSec === "number" ? meta.durationSec : undefined,
        resolution: typeof meta.resolution === "string" ? meta.resolution : undefined,
        sizeBytes: typeof meta.sizeBytes === "number" ? meta.sizeBytes : undefined,
        createdAt: typeof meta.createdAt === "string" ? meta.createdAt : undefined,
    });
    // I-1 (V6.1): 写顺序 prompt.json 先 / SKILL.md 后 — readSkillDetail 优先
    // 读 prompt.json (description / taskName / steps),所以两步写中间 crash 时
    // "prompt.json 已新 / SKILL.md 仍旧" 是可接受的 fall-forward 中间态
    // (用户看到的就是新内容,SKILL.md 是 derived view 后续会被下次编辑 / index
    // rebuild 重渲覆盖);反过来 "SKILL.md 已新 / prompt.json 仍旧" 是真不一致
    // (list 显示旧、SKILL.md body 显示新)。
    if (promptDirty) {
        if (!(await isSameSafeReferenceSlugDir(safe))) {
            return { kind: "not-found" };
        }
        if (!(await overwriteSameRegularFileWithSync(promptJsonPath, promptIdentity, JSON.stringify(nextPrompt, null, 2)))) {
            return { kind: "not-found" };
        }
    }
    if (!(await isSameSafeReferenceSlugDir(safe))) {
        return { kind: "not-found" };
    }
    if (!(await overwriteSameRegularFileWithSync(skillMd, skillMdIdentity, renderedMd))) {
        return { kind: "not-found" };
    }
    // V6.4: prompt.json + SKILL.md 都写成功后,刷新顶层 vtp-recording/SKILL.md 的
    // AUTO-INDEX (对齐 saveAsSkill / handleDeleteSkill 已有的 best-effort pattern)。
    // taskName / description 编辑后,host LLM 看到的 system-prompt 索引立即同步,
    // 否则会按旧 metadata 持续匹配 → 选错任务或匹配失败。rebuild 失败不回滚业务
    // 写入 (prompt.json + SKILL.md 是真理源,index 是 derived view,下次 saveAsSkill
    // / deleteSkill / hourly maintenance 会重渲覆盖)。
    try {
        const vtpRecordingDir = path.dirname(refDir);
        await rebuildCuaRecordingIndex(vtpRecordingDir);
    }
    catch (err) {
        api.logger?.warn?.(`[vtp] updateSkillMetadata: AUTO-INDEX rebuild failed: ${String(err)}`);
    }
    const detail = await readSkillDetail(api, slug);
    if (!detail)
        return { kind: "not-found" };
    return { kind: "ok", detail };
}
//# sourceMappingURL=task-template-store.js.map