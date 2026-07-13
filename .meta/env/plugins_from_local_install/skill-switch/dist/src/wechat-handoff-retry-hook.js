export function createWechatHandoffRetryHook(_api) {
    return (_event, _ctx) => {
        // DISABLED：微信 handoff 发图统一走 llm_output 主动 sendWechatHandoffViaOpenClaw。
        // 不再抓固定 handoff.jpg、不再 revise，避免与主动发双发。
        return undefined;
    };
}
//# sourceMappingURL=wechat-handoff-retry-hook.js.map