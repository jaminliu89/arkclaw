import type { OpenClawPluginApi } from "./types.js";
interface BuaFocusResult {
    ok: boolean;
    command: string[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    errorMessage?: string;
    /**
     * 当 ok=true 且 skipped=true 时，表示 session 在 bua 侧未登记 / 窗口已失效。
     * 这是正常状态（纯文本会话从未调用过 `bua open`），不应被视为错误。
     */
    skipped?: boolean;
    reason?: "no_browser_session";
}
export declare function registerSkillSwitchCommand(api: OpenClawPluginApi): void;
export declare function registerBuaFocusCommand(api: OpenClawPluginApi): void;
export declare function executeBuaFocus(api: OpenClawPluginApi, sessionKey: string): Promise<BuaFocusResult>;
export {};
//# sourceMappingURL=commands.d.ts.map