import type { OpenClawPluginApi } from "./types.js";
export declare function captureFreshHandoffScreenshot(): string | null;
/**
 * Just-in-time fresh capture into the fixed `handoff.jpg` path used by the
 * standard openclaw outbound MEDIA directive. Used for non-Feishu IM channels
 * (wechat etc.) where the outbound dispatcher reads raw MEDIA: path and the
 * plugin cannot rewrite the path via llm_output mutation (runVoidHook does not
 * propagate plugin event mutations, see openclaw/src/plugins/hooks.ts:557).
 *
 * tmp + rename pattern: capture into a temporary file first, then atomically
 * rename to `handoff.jpg`. POSIX rename is atomic within the same filesystem,
 * so the outbound dispatcher either sees the old complete file or the new
 * complete file — never a half-written one.
 *
 * Capture failure semantics: do NOT delete the existing `handoff.jpg`. If
 * capture fails the user gets the (stale) previous frame instead of `⚠️ Media
 * failed`. This is the explicit user decision: showing a slightly outdated
 * screenshot is better UX than a failure marker.
 *
 * 时序正确性依赖链(升级 openclaw 时必须 verify 这条链未被打破):
 *   1. plugin llm_output hook handler 同步早期调用 `captureHandoffScreenshotTo`
 *      → spawnSync("import", ..., timeout: 10s) **native sync block** 当前
 *      event loop tick;
 *   2. openclaw runVoidHook(hooks.ts:557)用
 *      `hooks.map(async (hook) => { ... })` 同步调每个 handler,handler
 *      body 同步部分(包括 spawnSync)在 `await Promise.all(...)` 之前
 *      就跑完;
 *   3. openclaw attempt.ts:4662 调用点是
 *      `hookRunner.runLlmOutput(...).catch(...)`(fire-and-forget),attempt
 *      主线程同步继续到 outbound dispatch — 但同一 event loop tick 已经被
 *      spawnSync block,所以 attempt 主线程到达 outbound dispatch 时,
 *      tmp 文件已写完 + rename 已完成。
 * 如果上游把 hook handler 调用挪到 microtask(`Promise.resolve().then`)或
 * 在 attempt outbound dispatch 链路上插入 await 边界,这条 guarantee 会破,
 * outbound 可能读到旧 handoff.jpg。升级 openclaw 时务必 grep `runLlmOutput`
 * + `runVoidHook` 实现确认。
 *
 * 单 DISPLAY 假设(并发):本函数抓 X11 DISPLAY=:99 root window,所有 session
 * 共享同一桌面。多用户/多 session 并发 capture 时,后到的 capture 会覆盖
 * 前一个 session 的 handoff.jpg。tmp 文件名带 pid+ts+random 只防 tmp 撞名,
 * 不防终态 handoff.jpg 撞名。本质上桌面图像就是单租户(:99 上只能跑一个
 * chrome/desktop),plugin 层不做 per-session 隔离 — 长期方案应改 unique
 * 文件名 + 改 SKILL.md 让 LLM 输 unique 路径,但那要换发送协议。
 */
export declare function captureHandoffScreenshotInPlace(): string | null;
/**
 * Legacy CUA prep hook: capture current desktop to the fixed handoff path for
 * diagnostics/source tracking. The IM sender no longer reads this path; it
 * captures its own unique file when it sees handoff intent.
 */
export declare function prepImHandoffScreenshotFromLatestRun(): string | null;
export declare function registerCuaCommand(api: OpenClawPluginApi): void;
//# sourceMappingURL=cua_commands.d.ts.map