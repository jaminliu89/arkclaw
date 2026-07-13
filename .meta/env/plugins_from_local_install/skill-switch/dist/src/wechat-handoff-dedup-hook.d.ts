import type { OpenClawPluginApi } from "./types.js";
export declare function createWechatHandoffDedupHook(api: OpenClawPluginApi): (event: any, _ctx: any) => {
    cancel: boolean;
    cancelReason?: string;
} | undefined;
//# sourceMappingURL=wechat-handoff-dedup-hook.d.ts.map