const DEFAULT_WORKSPACE = "/root/.openclaw/workspace";
export function resolveWorkspaceDir(api) {
    // 优先使用 resolveAgentWorkspaceDir（新版 API）
    const agent = api.runtime?.agent;
    if (agent && typeof agent.resolveAgentWorkspaceDir === "function") {
        return agent.resolveAgentWorkspaceDir(api.config);
    }
    // 兼容旧版：从 config.agents.defaults.workspace 读取
    const configWorkspace = api.config?.agents?.defaults?.workspace;
    if (typeof configWorkspace === "string" && configWorkspace) {
        return configWorkspace;
    }
    // 最终回退到默认值
    return DEFAULT_WORKSPACE;
}
//# sourceMappingURL=workspace.js.map