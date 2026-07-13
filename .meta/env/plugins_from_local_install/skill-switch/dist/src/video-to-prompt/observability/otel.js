// VTP 二期 P4 可观测性 — plugin 侧 OTel SDK 初始化 (Task 2.2)。
//
// service.name = "vtp" — plugin 侧手动 span + metric,无 auto-instrumentation。
// 与 runtime/agents/video-to-prompt/src/observability/otel.ts 的区别:
//   - 无 getNodeAutoInstrumentations / OpenAIInstrumentation (plugin 无 LLM 调用)
//   - initOtel 幂等:第二次调用直接返回已有 sdk,不重复 start
//   - 导出 flushOtelSync 供 beforeExit handler 在进程自然退出前 flush
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { PeriodicExportingMetricReader, AggregationTemporality, } from "@opentelemetry/sdk-metrics";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
let initialized = false;
let _metricReader = null;
let _sdk = null;
let _spanProcessor = null;
export function initOtel(runId, endpoint) {
    // I-2 (review): 测试环境跳过真实 SDK 启动 —— sdk.start() 会注册
    // metric timer + signal handler,泄漏到 vitest 进程。与 logger.ts
    // 的 VITEST 守卫一致。
    if (process.env.VITEST) {
        return null;
    }
    if (initialized && _sdk !== null) {
        return _sdk;
    }
    try {
        const resource = new Resource({
            [SemanticResourceAttributes.SERVICE_NAME]: "vtp",
            [SemanticResourceAttributes.SERVICE_VERSION]: process.env.VTP_VERSION ?? "0.0.0",
            [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: runId,
        });
        if (endpoint) {
            // 单端点同时服务 traces + metrics —— SDK 各自附 /v1/traces、/v1/metrics。
            process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint.replace(/\/+$/, "");
        }
        const metricReader = new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
                temporalityPreference: AggregationTemporality.DELTA,
            }),
            exportIntervalMillis: 2000,
            exportTimeoutMillis: 2000,
        });
        _metricReader = metricReader;
        const spanProcessor = new SimpleSpanProcessor(new OTLPTraceExporter());
        const sdk = new NodeSDK({
            resource,
            spanProcessor,
            metricReader,
        });
        sdk.start();
        _sdk = sdk;
        _spanProcessor = spanProcessor;
        if (!initialized) {
            initialized = true;
            // I-1 (review): plugin 与 openclaw gateway 同进程 —— plugin 侧 OTel
            // 只注册 beforeExit 被动 flush(进程自然退出时排空 metric/span 积压)。
            // 绝不注册 SIGTERM/SIGINT/uncaughtException handler、绝不 process.exit:
            // 否则 VTP 会单方面接管并终结整个 gateway 进程,越过 plugin 边界
            // (host 或别的 plugin 的可恢复异常会被升级成 gateway 宕机)。
            // runtime/agents/video-to-prompt 的 otel.ts 是独立 SEA 进程,保留
            // 全套 handler 才正确 —— 两边进程模型不同,不要再对齐复制。
            process.once("beforeExit", () => {
                // DRY: delegate to flushOtelSync (trace + metric, 2.5s ceiling)
                void flushOtelSync()
                    .catch(() => { })
                    .finally(() => {
                    sdk.shutdown().catch(() => { });
                });
            });
        }
        return sdk;
    }
    catch (e) {
        process.stderr.write(`[otel] init failed: ${e instanceof Error ? e.message : String(e)}\n`);
        _metricReader = null;
        return null;
    }
}
// flushOtelSync — 供 beforeExit handler 在进程自然退出前显式 flush。
//
// 同时 flush:
//   1. metricReader.forceFlush() — 强制导出 metric 积压
//   2. _spanProcessor.forceFlush() — 强制导出 SimpleSpanProcessor 中 in-flight
//      的 span HTTP POST（否则 process.exit 会 kill 未完成的导出请求）
//      注: trace.getTracerProvider() 返回 ProxyTracerProvider（无 forceFlush），
//      故直接持有 SimpleSpanProcessor 引用，而非通过 getTracerProvider() 间接 flush。
//
// 整体超时 2.5s — 防止 collector 不响应时无限阻塞 process.exit。
// Never throws — 所有 flush 错误静默忽略。
// beforeExit handler 不会在 process.exit() 时触发，故需此 helper。
export async function flushOtelSync() {
    const flushAll = async () => {
        if (_metricReader) {
            try {
                await _metricReader.forceFlush();
            }
            catch {
                // silent
            }
        }
        // Flush the span processor directly — SimpleSpanProcessor.forceFlush() drains
        // in-flight span HTTP POSTs that would otherwise be killed by process.exit().
        if (_spanProcessor) {
            try {
                await _spanProcessor.forceFlush();
            }
            catch {
                // silent
            }
        }
    };
    try {
        await Promise.race([
            flushAll(),
            new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
    }
    catch {
        // silent
    }
}
//# sourceMappingURL=otel.js.map