/**
 * SPIKE P1 — verify openclaw 官方 plugin SDK `deliverOutboundPayloads`
 * 主动发图能力(V3/V4 ECS 实测验证用,完全 isolated,不影响 V7 行为)。
 *
 * 触发条件(三选一,只要 enable 就触发,不去重):
 *   1. env var `SKILL_SWITCH_SPIKE_P1=1`
 *   2. marker 文件 `~/.openclaw/.enable-spike-p1` 存在
 *   3. 都没启用 → 整个 spike 入口 no-op,V7 行为完全不变
 *
 * 调用方式:`createAfterToolCallHook` 在 V7 现有 after_tool_call 逻辑之前
 * 插入 spike 入口分支,检测 `bua` / `cua` 工具调用 + IM 渠道 → 异步调
 * `runSpikeP1Send`(不 await,不阻塞 hook),触发后:
 *   - dump `sessionKey / messageProvider / agentId / parsed channel/to` 到
 *     `<stateDir>/extensions/skill-switch/spike-p1.log`
 *   - 调 `deliverOutboundPayloads({channel, to, payloads:[{mediaUrls:[handoffPath]}]})`
 *   - dump returned `OutboundDeliveryResult[]` 或 catch 的错误到同 log
 *
 * Spike 跟 V7 共存(双发图预期):V7 用 cross-plugin require 发飞书,
 * spike 同时调 P1 也发一张图。User 在飞书/微信端会**收到 2 张图**,
 * 这是预期的实验结果,用于 verify P1 路径真能到达 channel。
 *
 * Log 文件:`<stateDir>/extensions/skill-switch/spike-p1.log`
 *   - 每行 1 个 JSON event
 *   - stage 字段:`trigger / calling_deliverOutboundPayloads / result / error / skip`
 *
 * 设计约束:
 *   - 永不抛错(catch all),即使 spike 失败也不破坏 V7 production 路径
 *   - 不去重,user 自己控制触发频率(跑 1 次 bua / cua 触发 1 次)
 *   - 使用 V7 现有 `handoff.jpg`(如果存在)— 不自己抓图,纯 verify 发送能力
 */
import type { OpenClawPluginApi } from "./types.js";
/** spike trigger 总开关:env var 或 marker 文件任一启用即可 */
export declare function isSpikeEnabled(): boolean;
export declare function runSpikeP1Send(params: {
    api: OpenClawPluginApi;
    sessionKey: string;
    messageProvider: string;
    agentId?: string;
    channelId?: string;
    triggerReason: string;
}): Promise<void>;
//# sourceMappingURL=spike-p1-sender.d.ts.map