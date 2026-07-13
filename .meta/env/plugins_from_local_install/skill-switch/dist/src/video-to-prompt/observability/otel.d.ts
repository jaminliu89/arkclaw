import { NodeSDK } from "@opentelemetry/sdk-node";
export declare function initOtel(runId: string, endpoint?: string): NodeSDK | null;
export declare function flushOtelSync(): Promise<void>;
//# sourceMappingURL=otel.d.ts.map