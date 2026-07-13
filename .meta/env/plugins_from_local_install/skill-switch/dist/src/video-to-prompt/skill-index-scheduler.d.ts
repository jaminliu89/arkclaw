export interface SkillIndexSchedulerCtx {
    intervalHours: number;
    rebuildFn: () => Promise<{
        slugCount: number;
        changed: boolean;
    }>;
    onError?: (err: unknown) => void;
}
export interface SkillIndexSchedulerHandle {
    stop: () => void;
}
export declare function startSkillIndexScheduler(ctx: SkillIndexSchedulerCtx): SkillIndexSchedulerHandle;
//# sourceMappingURL=skill-index-scheduler.d.ts.map