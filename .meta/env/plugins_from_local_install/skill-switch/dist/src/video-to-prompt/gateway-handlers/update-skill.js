// VTP F-B updateSkill RPC handler (V6.2 review 收敛后).
//
// 修改任务模板 metadata + 5 块 prompt 字段 (taskName / description /
// preconditions / steps / expectedResult / confidence)。slug 不可改 — 改 slug
// = deleteSkill + saveAsSkill。
//
// 写盘范围严格限制在 reference/<slug>/ (任务模板域),不触碰 runs/<rid>/ 录制域
// (D-20 双域解耦)。
//
// 字段语义 (C-1 V6.1 修复后):
//   - description = SKILL.md frontmatter description + 同步 prompt.json.description
//   - taskName / preconditions / steps / expectedResult / confidence = prompt.json
//     5 块;taskName 同时驱动 SKILL.md body `# title`
//   - SKILL.md frontmatter `name:` 不在 patch surface;永远 = slug (= dir 名),
//     由 store 内部 finalName = existingMd.name ?? slug 强制。E-7 invariant
//     (assertSkillNameConsistency: dirName === frontmatter.name) 由本路径主动
//     维护。前端 UI "任务名称" 走 `taskName` 不要走 `name`。
//   - qualityNotice 是 LLM analyzer 写入的质量提示 (system-owned),deliberately
//     not exposed via this RPC;前端不应编辑。
//
// 校验:任何 prompt 字段变更后走 validatePromptShape (allowlist + shape),
//      不合法返回 PROMPT_VALIDATION_FAILED + details.errors。
//
// V6.2 I6.2-2: handler 不再做 baseline 拉取 — V6.1 引入的 readSkillDetail
// 是 store re-read prompt.json 之前的 TOCTOU 窗口,baseline 可能 stale 后
// overwrite 新值。改为让 store 内部在 normalize 前用 mdFields 给 taskName/
// description 补 fallback;legacy schema 残缺时 store 仍 fail 但 errors
// 指向真 missing,UI 可指引用户补齐 (Per-slug lock 是真正的根治,标为 TODO)。
//
// V6.2 I6.2-3 + M-NEW-3: handler 显式拒收非 string 的 taskName / description /
// expectedResult 与非 number 的 confidence + trim 后空字符串。避免类型错配
// 静默 fallback 到 baseline (用户以为 "已保存" 实际未生效)。
import { updateSkillMetadata, } from "../task-template-store.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
export async function handleUpdateSkill(api, ctx) {
    const params = ctx.params;
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    if (!slug)
        return respondError(ctx, "BAD_REQUEST", "slug required");
    // C-1 (V6.1): patch.name 已从 surface 删除 — 不解析,前端 "任务名称" 应走
    // taskName。任何残留 params.name 静默忽略 (向后兼容旧前端)。
    const patch = {};
    // V6.2 I6.2-3 + M-NEW-3: 类型严格 + trim 拒空字符串 — 用户提交空字段不应
    // 走 silent fallback baseline 路径。
    if (params?.description !== undefined) {
        if (typeof params.description !== "string") {
            return respondError(ctx, "BAD_REQUEST", "description must be a string");
        }
        const trimmed = params.description.trim();
        if (!trimmed) {
            return respondError(ctx, "BAD_REQUEST", "description must not be empty");
        }
        patch.description = trimmed;
    }
    if (params?.taskName !== undefined) {
        if (typeof params.taskName !== "string") {
            return respondError(ctx, "BAD_REQUEST", "taskName must be a string");
        }
        const trimmed = params.taskName.trim();
        if (!trimmed) {
            return respondError(ctx, "BAD_REQUEST", "taskName must not be empty");
        }
        patch.taskName = trimmed;
    }
    if (params?.expectedResult !== undefined) {
        if (typeof params.expectedResult !== "string") {
            return respondError(ctx, "BAD_REQUEST", "expectedResult must be a string");
        }
        const trimmed = params.expectedResult.trim();
        if (!trimmed) {
            return respondError(ctx, "BAD_REQUEST", "expectedResult must not be empty");
        }
        patch.expectedResult = trimmed;
    }
    if (params?.confidence !== undefined) {
        if (typeof params.confidence !== "number") {
            return respondError(ctx, "BAD_REQUEST", "confidence must be a number");
        }
        patch.confidence = params.confidence;
    }
    // preconditions / steps 类型由 validatePromptShape 二次校验 (string[] /
    // step object[]),这里只过滤 undefined / 透传原值。null 视同 undefined
    // (前端 form clear 可能传 null) — 一致与其它字段。
    if (params?.preconditions !== undefined && params.preconditions !== null) {
        patch.preconditions = params.preconditions;
    }
    if (params?.steps !== undefined && params.steps !== null) {
        patch.steps = params.steps;
    }
    try {
        const result = await updateSkillMetadata(api, slug, patch);
        if (result.kind === "not-found") {
            try {
                incrementCounter("vtp.template.update.total", {
                    kind: "skill",
                    result: "error",
                    error_code: "SLUG_NOT_FOUND",
                });
            }
            catch {
                // silent — instrumentation must not break business logic
            }
            return respondError(ctx, "SLUG_NOT_FOUND", `task template not found for slug: ${slug}`);
        }
        if (result.kind === "invalid") {
            try {
                incrementCounter("vtp.template.update.total", {
                    kind: "skill",
                    result: "error",
                    error_code: "PROMPT_VALIDATION_FAILED",
                });
            }
            catch {
                // silent
            }
            return respondError(ctx, "PROMPT_VALIDATION_FAILED", `prompt validation failed: ${result.errors.length} issue(s)`, { errors: result.errors });
        }
        try {
            incrementCounter("vtp.template.update.total", {
                kind: "skill",
                result: "success",
            });
        }
        catch {
            // silent
        }
        ctx.respond(true, { skill: result.detail });
    }
    catch (err) {
        try {
            incrementCounter("vtp.template.update.total", {
                kind: "skill",
                result: "error",
                error_code: "INTERNAL_ERROR",
            });
        }
        catch {
            // silent
        }
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.updateSkill", async (ctx) => {
        const slugParam = typeof ctx.params?.slug === "string" ? ctx.params.slug.trim() : "";
        await withRpcCommandSpan(ctx, "updateSkill", slugParam ? { "vtp.template_slug": slugParam } : {}, async (ctx, span) => {
            if (slugParam) {
                span.setAttribute("vtp.template_slug", slugParam);
            }
            await handleUpdateSkill(api, ctx);
        });
    });
}
//# sourceMappingURL=update-skill.js.map