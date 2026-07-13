import { n as CodexAppServerRpcError } from "./client-DMXvboVu.js";
import { b as buildCodexAppInventoryCacheKey } from "./thread-lifecycle-Dv9Npl7a.js";
import { a as releaseLeasedSharedCodexAppServerClient, c as withTimeout, i as getLeasedSharedCodexAppServerClient, m as resolveCodexAppServerHomeDir, r as createIsolatedCodexAppServerClient } from "./shared-client-Duh1bHaP.js";
import { t as resolveCodexAppServerDirectSandboxBypassBlock } from "./sandbox-guard-mXE4_vE_.js";
import { createHash } from "node:crypto";
//#region extensions/codex/src/app-server/capabilities.ts
const CODEX_CONTROL_METHODS = {
	account: "account/read",
	compact: "thread/compact/start",
	feedback: "feedback/upload",
	listMcpServers: "mcpServerStatus/list",
	listSkills: "skills/list",
	listThreads: "thread/list",
	rateLimits: "account/rateLimits/read",
	resumeThread: "thread/resume",
	review: "review/start"
};
function describeControlFailure(error) {
	if (isUnsupportedControlError(error)) return "unsupported by this Codex app-server";
	return error instanceof Error ? error.message : String(error);
}
function isUnsupportedControlError(error) {
	return error instanceof CodexAppServerRpcError && error.code === -32601;
}
//#endregion
//#region extensions/codex/src/app-server/plugin-app-cache-key.ts
function buildCodexPluginAppCacheKey(params) {
	return buildCodexAppInventoryCacheKey({
		codexHome: resolveCodexPluginAppCacheCodexHome(params.appServer, params.agentDir),
		endpoint: resolveCodexPluginAppCacheEndpoint(params.appServer),
		authProfileId: params.authProfileId,
		accountId: params.accountId,
		envApiKeyFingerprint: params.envApiKeyFingerprint,
		appServerVersion: params.appServerVersion
	});
}
function resolveCodexPluginAppCacheEndpoint(appServer) {
	return JSON.stringify({
		transport: appServer.start.transport,
		command: appServer.start.command,
		args: appServer.start.args,
		url: appServer.start.url ?? null,
		credentialFingerprint: fingerprintCodexPluginAppCacheCredentials(appServer.start)
	});
}
function resolveCodexPluginAppCacheCodexHome(appServer, agentDir) {
	const configuredCodexHome = appServer.start.env?.CODEX_HOME?.trim();
	if (configuredCodexHome) return configuredCodexHome;
	return appServer.start.transport === "stdio" && agentDir ? resolveCodexAppServerHomeDir(agentDir) : void 0;
}
function fingerprintCodexPluginAppCacheCredentials(startOptions) {
	const authToken = startOptions.authToken ?? "";
	const headers = Object.entries(startOptions.headers).map(([key, value]) => [key.toLowerCase(), value]).toSorted(([left], [right]) => left.localeCompare(right));
	if (!authToken && headers.length === 0) return null;
	const hash = createHash("sha256");
	hash.update("openclaw:codex:plugin-app-cache-credentials:v1");
	hash.update("\0");
	hash.update(authToken);
	for (const [key, value] of headers) {
		hash.update("\0");
		hash.update(key);
		hash.update("\0");
		hash.update(value);
	}
	return `sha256:${hash.digest("hex")}`;
}
//#endregion
//#region extensions/codex/src/app-server/request.ts
async function requestCodexAppServerJson(params) {
	const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
		method: params.method,
		requestParams: params.requestParams,
		config: params.config,
		sessionKey: params.sessionKey,
		sessionId: params.sessionId
	});
	if (sandboxBlock) throw new Error(sandboxBlock);
	const timeoutMs = params.timeoutMs ?? 6e4;
	return await withTimeout((async () => {
		const client = await (params.isolated ? createIsolatedCodexAppServerClient : getLeasedSharedCodexAppServerClient)({
			startOptions: params.startOptions,
			timeoutMs,
			authProfileId: params.authProfileId,
			agentDir: params.agentDir,
			config: params.config
		});
		try {
			return await client.request(params.method, params.requestParams, { timeoutMs });
		} finally {
			if (params.isolated) await client.closeAndWait({
				exitTimeoutMs: 2e3,
				forceKillDelayMs: 250
			});
			else releaseLeasedSharedCodexAppServerClient(client);
		}
	})(), timeoutMs, `codex app-server ${params.method} timed out`);
}
//#endregion
export { describeControlFailure as i, buildCodexPluginAppCacheKey as n, CODEX_CONTROL_METHODS as r, requestCodexAppServerJson as t };
