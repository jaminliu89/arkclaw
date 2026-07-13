// 二期 F-B：arkclawVtpRecording.deleteSkill —— 任务模板独立删除。
// 形状（D-21）：入参 { slug }；出参 { success: true, slug, alreadyDeleted? }
// 不动 runs/<sourceRecordingId>/（spec：录制独立生命周期）。
import path from "node:path";
import { deleteSavedSkill, resolveReferenceDir, } from "../task-template-store.js";
import { rebuildCuaRecordingIndex } from "../recording-index.js";
import { listRecordings, patchRecording } from "../recording-state.js";
import { respondError, redactError } from "./shared.js";
import { withRpcCommandSpan } from "./observability.js";
import { incrementCounter } from "../observability/metrics.js";
import { vtpLog } from "../observability/logger.js";
export async function handleDeleteSkill(api, ctx) {
    try {
        const slug = typeof ctx.params?.slug === "string" ? ctx.params.slug.trim() : "";
        if (!slug) {
            respondError(ctx, "BAD_REQUEST", "slug is required");
            return;
        }
        const refDir = resolveReferenceDir(api);
        const deleteResult = await deleteSavedSkill(refDir, slug);
        if (deleteResult.deleteFailed) {
            respondError(ctx, "TEMPLATE_DELETE_FAILED", `failed to delete template: ${slug}`, {
                errors: deleteResult.errors ?? [],
            });
            return;
        }
        const { deleted, alreadyDeleted } = deleteResult;
        // 同步 state.recordings[].savedSkills —— 删除该 slug 的引用。
        // 避免后续 list/status 仍 surface 已物理消失的 slug。
        try {
            const stateDir = api.runtime.state.resolveStateDir();
            const all = await listRecordings(stateDir);
            for (const rec of all) {
                if (!rec.savedSkills?.length)
                    continue;
                const next = rec.savedSkills.filter((s) => s.slug !== slug);
                if (next.length !== rec.savedSkills.length) {
                    await patchRecording(stateDir, rec.recordingId, {
                        savedSkills: next,
                    });
                }
            }
        }
        catch (err) {
            api.logger?.warn?.(`[vtp] deleteSkill: state savedSkills sync failed: ${String(err)}`);
        }
        // rebuild AUTO-INDEX so SKILL.md no longer references deleted slug
        try {
            const parent = path.dirname(refDir); // vtpRecordingDir
            await rebuildCuaRecordingIndex(parent);
        }
        catch (err) {
            api.logger?.warn?.(`[vtp] deleteSkill: AUTO-INDEX rebuild failed: ${String(err)}`);
        }
        // Phase 5.2 observability: metric + audit log on delete outcome.
        // Both deleted=true and alreadyDeleted=true are treated as success
        // (idempotent delete is not an error).
        try {
            incrementCounter("vtp.template.delete.total", { result: "success" });
        }
        catch {
            // silent — instrumentation must not break business logic
        }
        if (deleted) {
            try {
                vtpLog.info(undefined, {
                    event: "template_deleted",
                    slug,
                    triggerEvent: "user",
                });
            }
            catch {
                // silent
            }
        }
        ctx.respond(true, {
            success: true,
            slug,
            ...(alreadyDeleted ? { alreadyDeleted: true } : { deleted }),
        });
    }
    catch (err) {
        try {
            incrementCounter("vtp.template.delete.total", {
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
    api.registerGatewayMethod("arkclawVtpRecording.deleteSkill", async (ctx) => {
        const slugParam = typeof ctx.params?.slug === "string" ? ctx.params.slug.trim() : "";
        await withRpcCommandSpan(ctx, "deleteSkill", slugParam ? { "vtp.template_slug": slugParam } : {}, async (ctx, span) => {
            if (slugParam) {
                span.setAttribute("vtp.template_slug", slugParam);
            }
            await handleDeleteSkill(api, ctx);
        });
    });
}
//# sourceMappingURL=delete-skill.js.map