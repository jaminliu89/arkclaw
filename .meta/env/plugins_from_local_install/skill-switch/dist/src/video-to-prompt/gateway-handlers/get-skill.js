// VTP F-B getSkill RPC handler (二期新增).
// 任务模板详情读取入口(编辑面板必经)。返回 SkillDetail = SkillView +
// 完整 prompt.json。不写 invocations.jsonl。
import { readSkillDetail } from "../task-template-store.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export async function handleGetSkill(api, ctx) {
    const params = ctx.params;
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    if (!slug)
        return respondError(ctx, "BAD_REQUEST", "slug required");
    try {
        const detail = await readSkillDetail(api, slug);
        if (!detail) {
            return respondError(ctx, "SLUG_NOT_FOUND", `task template not found for slug: ${slug}`);
        }
        ctx.respond(true, { skill: detail });
    }
    catch (err) {
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.getSkill", (ctx) => withRpcCommandSpan(ctx, "getSkill", {}, (c) => handleGetSkill(api, c)));
}
//# sourceMappingURL=get-skill.js.map