import os from "node:os";
import path from "node:path";
// #8 cross-platform: previous hardcoded /root/.openclaw/workspace assumed
// Linux + root-owned ECS deploys; broke on macOS / Linux non-root local dev.
// Production environments have host inject runtime.agent.resolveAgentWorkspaceDir
// so the fallback path is dev-only — but a portable default still matters
// for unit tests, IDE TypeScript server, and one-off shell exploration.
const DEFAULT_WORKSPACE = path.join(os.homedir(), ".openclaw", "workspace");
export function resolveWorkspaceDir(api) {
    const agent = api.runtime?.agent;
    if (agent && typeof agent.resolveAgentWorkspaceDir === "function") {
        return agent.resolveAgentWorkspaceDir(api.config);
    }
    const configWorkspace = api.config
        ?.agents?.defaults?.workspace;
    if (typeof configWorkspace === "string" && configWorkspace) {
        return configWorkspace;
    }
    return DEFAULT_WORKSPACE;
}
//# sourceMappingURL=workspace.js.map