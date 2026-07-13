import type { GatewayContext } from "../types.js";
import type { VtpSpan } from "../observability/tracer.js";
export declare function withRpcCommandSpan(ctx: GatewayContext, rpcName: string, attrs: Record<string, unknown>, body: (ctx: GatewayContext, span: VtpSpan) => Promise<void>): Promise<void>;
//# sourceMappingURL=observability.d.ts.map