// VTP F-B listSkill RPC handler (二期新增,取代一期 list).
// 仅扫 reference/<slug>/,不读 state.recordings (D-20 双域解耦)。
import { listAllSkills, resolveReferenceDir } from "../task-template-store.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
export async function handleListSkill(api, ctx) {
    try {
        const refDir = resolveReferenceDir(api);
        const params = ctx.params;
        const opts = {};
        if (typeof params?.q === "string")
            opts.q = params.q;
        if (typeof params?.limit === "number")
            opts.limit = params.limit;
        if (typeof params?.offset === "number")
            opts.offset = params.offset;
        const { skills, total } = await listAllSkills(refDir, opts);
        const offset = opts.offset ?? 0;
        ctx.respond(true, {
            skills,
            meta: { total, hasMore: offset + skills.length < total },
        });
    }
    catch (err) {
        respondError(ctx, "INTERNAL_ERROR", redactError(err));
    }
}
export function register(api) {
    api.registerGatewayMethod("arkclawVtpRecording.listSkill", (ctx) => withRpcCommandSpan(ctx, "listSkill", {}, (c) => handleListSkill(api, c)));
}
//# sourceMappingURL=list-skill.js.map