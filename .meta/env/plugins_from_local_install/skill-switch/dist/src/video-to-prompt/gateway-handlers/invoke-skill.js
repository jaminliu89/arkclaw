// 二期 F-B：arkclawVtpRecording.invokeSkill —— 任务模板"立即执行"专用入口。
//
// 形状（D-21 / V6.4）：
//   入参：{ slug }
//   出参：{ skill: SkillView, invocation: { invocationId, triggerSentence, fullPrompt, triggerPrompt, triggeredAt } }
//   错误：BAD_REQUEST / SLUG_NOT_FOUND
//
// 行为（V6.4）：
//   1. 拒收 recordingId（renderInstruction 才是 raw recording 入口）
//   2. readSkillDetail 拿全 detail
//   3. renderTriggerSentence(taskName) → triggerSentence(单句中文 trigger,默认)
//      renderUserFacingPrompt(prompt) → fullPrompt(5 段中文,用户查全量用)
//   4. triggerPrompt 是 deprecated alias = triggerSentence,V6.5 删（详 ADR-0030）
//
// 注：「执行次数」维度已移除,本入口不再写 invocations.jsonl。
import { randomUUID } from "node:crypto";
import { readSkillDetail } from "../task-template-store.js";
import { renderTriggerSentence, renderUserFacingPrompt, } from "../prompt-rendering.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
import { vtpLog } from "../observability/logger.js";
export async function handleInvokeSkill(api, ctx) {
    try {
        // 拒收 recordingId（仅当未传 slug 时报 hint）
        const slugParam = typeof ctx.params?.slug === "string" ? ctx.params.slug.trim() : "";
        const recordingIdParam = typeof ctx.params?.recordingId === "string"
            ? ctx.params.recordingId.trim()
            : "";
        if (recordingIdParam && !slugParam) {
            respondError(ctx, "BAD_REQUEST", "invokeSkill requires { slug }; use renderInstruction for raw recording prompt", { hint: "Pass { slug } for a saved task template." });
            return;
        }
        if (!slugParam) {
            respondError(ctx, "BAD_REQUEST", "slug is required");
            return;
        }
        const detail = await readSkillDetail(api, slugParam);
        if (!detail) {
            respondError(ctx, "SLUG_NOT_FOUND", `Task template not found for slug: ${slugParam}`);
            return;
        }
        // V6.4 post-review fix-I (Cluster 3): SkillDetail.prompt 与 PromptArtifact
        // 类型 drift —— 前者 steps[] 字段名是 `index`(C-1 设计:与 SKILL.md 顺序
        // 一致),后者用 `stepIndex`(prompt.json 原生 schema)。三方 review 后采用
        // Case B conversion layer (而非 swap 类型 — readSkillDetail 真实返回带
        // source/createdAt 字段,直接改 SkillDetail.prompt 类型会破多个 callers)。
        const prompt = {
            taskName: detail.prompt.taskName,
            description: detail.prompt.description,
            preconditions: detail.prompt.preconditions,
            expectedResult: detail.prompt.expectedResult,
            confidence: detail.prompt.confidence,
            steps: detail.prompt.steps.map((s) => {
                const { index, ...rest } = s;
                return {
                    ...rest,
                    stepIndex: typeof index === "number" ? index : undefined,
                };
            }),
        };
        const triggerSentence = renderTriggerSentence(prompt.taskName ?? null);
        const fullPrompt = renderUserFacingPrompt(prompt);
        // V6.4: triggerPrompt 保留作为 alias = triggerSentence,前端 1 release 周期兼容窗口。
        // TODO(V6.5): 删除此 alias 字段。
        const triggerPrompt = triggerSentence;
        const invocationId = `inv_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        const triggeredAt = new Date().toISOString();
        const skill = {
            slug: detail.slug,
            name: detail.name,
            description: detail.description,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            sourceRecordingId: detail.sourceRecordingId,
        };
        // observability: invokeSkill RPC 调用量 metric + audit log。这是 RPC
        // 监控维度(调用量),与已移除的面向用户的「执行次数」不同。
        // F-5 (review V5): trigger_source 字面常量 "button" cardinality=1,label
        // 无信息价值;删 label,counter total 仍可用作 RPC 调用量。未来 RPC 若接
        // 受 triggerSource 入参,再恢复 label。
        try {
            incrementCounter("vtp.template.invocation.total", {});
        }
        catch {
            // silent — instrumentation must not break business logic
        }
        try {
            vtpLog.info(undefined, {
                event: "template_invoked",
                slug: detail.slug,
            });
        }
        catch {
            // silent
        }
        ctx.respond(true, {
            skill,
            invocation: {
                invocationId,
                triggerSentence, // V6.4 新:单句中文
                fullPrompt, // V6.4 新:5 段中文
                triggerPrompt, // V6.4 deprecated alias (V6.5 删)
                triggeredAt,
            },
        });
    }
    catch (err) {
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.invokeSkill", async (ctx) => {
        const slugParam = typeof ctx.params?.slug === "string" ? ctx.params.slug.trim() : "";
        await withRpcCommandSpan(ctx, "invokeSkill", slugParam ? { "vtp.template_slug": slugParam } : {}, async (ctx, span) => {
            if (slugParam) {
                span.setAttribute("vtp.template_slug", slugParam);
            }
            await handleInvokeSkill(api, ctx);
        });
    });
}
//# sourceMappingURL=invoke-skill.js.map