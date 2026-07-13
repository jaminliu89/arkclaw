import { detectConversationSource } from "./conversation-source.js";
import { getNonEmptyString, resolveSessionId } from "./utils.js";
const sessionModelCache = new Map();
function normalizeConfigString(value) {
    return String(value ?? "")
        .trim()
        .replace(/^[`'\"]+/, "")
        .replace(/[`'\"]+$/, "");
}
function splitModelSpec(modelSpec) {
    const [provider, modelId] = modelSpec.split("/", 2);
    if (!provider || !modelId) {
        return null;
    }
    return { provider: provider.trim(), modelId: modelId.trim() };
}
function normalizeProviderAndModel(event) {
    const modelSpec = getNonEmptyString(event?.model);
    const providerHint = getNonEmptyString(event?.provider);
    if (!modelSpec) {
        return null;
    }
    const split = splitModelSpec(modelSpec);
    if (split) {
        return {
            provider: providerHint ?? split.provider,
            modelId: split.modelId,
        };
    }
    if (!providerHint) {
        return null;
    }
    return {
        provider: providerHint,
        modelId: modelSpec,
    };
}
function resolveProviderConfig(config, provider) {
    const providerName = getNonEmptyString(provider);
    if (!providerName) {
        return { ok: false, reason: "provider_missing" };
    }
    const providers = config?.models?.providers;
    if (providers == null || typeof providers !== "object" || Array.isArray(providers)) {
        return { ok: false, reason: "provider_config_missing" };
    }
    const entry = providers[providerName];
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, reason: "provider_config_missing" };
    }
    const apiKey = normalizeConfigString(entry.apiKey);
    if (!apiKey) {
        return { ok: false, reason: "api_key_missing" };
    }
    const baseUrl = normalizeConfigString(entry.baseUrl);
    if (!baseUrl) {
        return { ok: false, reason: "base_url_missing" };
    }
    return {
        ok: true,
        provider: providerName,
        apiKey,
        baseUrl,
    };
}
export function captureSessionModelFromLlmInput(api, event, ctx) {
    try {
        const sessionId = resolveSessionId(ctx, event);
        if (!sessionId) {
            return { kind: "skipped", reason: "no_session" };
        }
        const source = detectConversationSource({
            sessionKey: sessionId,
            messageProvider: getNonEmptyString(ctx?.messageProvider) ?? undefined,
        });
        if (source !== "web") {
            return { kind: "skipped", reason: "non_web" };
        }
        if (!getNonEmptyString(event?.model)) {
            return { kind: "skipped", reason: "no_model" };
        }
        const normalized = normalizeProviderAndModel(event);
        if (!normalized) {
            return { kind: "fallback", reason: "invalid_model_spec" };
        }
        const providerConfig = resolveProviderConfig(api.config, normalized.provider);
        if (!providerConfig.ok) {
            return { kind: "fallback", reason: providerConfig.reason };
        }
        const snapshot = {
            sessionId,
            scope: "web",
            provider: providerConfig.provider,
            modelId: normalized.modelId,
            apiKey: providerConfig.apiKey,
            baseUrl: providerConfig.baseUrl,
            observedAt: new Date().toISOString(),
        };
        sessionModelCache.set(sessionId, snapshot);
        return { kind: "captured", snapshot };
    }
    catch {
        return { kind: "fallback", reason: "unknown_error" };
    }
}
export function getSessionModelSnapshot(sessionId) {
    if (!sessionId) {
        return null;
    }
    return sessionModelCache.get(sessionId) ?? null;
}
export function buildCuaOverrideArgv(sessionId) {
    const snapshot = getSessionModelSnapshot(sessionId);
    if (!snapshot) {
        return [];
    }
    return [
        "--provider",
        snapshot.provider,
        "--model-id",
        snapshot.modelId,
        "--base-url",
        snapshot.baseUrl,
        "--api-key",
        snapshot.apiKey,
    ];
}
export function injectCuaOverrideIntoCommand(command, sessionId, escapeShellArg) {
    if (!sessionId) {
        return { command, injected: false, reason: "no_session" };
    }
    if (!/cua\.sh\s+run(\s|$)/.test(command)) {
        return { command, injected: false, reason: "not_run" };
    }
    if (/--(?:provider|model-id|base-url|api-key)\b/.test(command)) {
        return { command, injected: false, reason: "explicit_args" };
    }
    const snapshot = getSessionModelSnapshot(sessionId);
    if (!snapshot) {
        return { command, injected: false, reason: "no_cache" };
    }
    const injectedFlags = [
        "--provider",
        escapeShellArg(snapshot.provider),
        "--model-id",
        escapeShellArg(snapshot.modelId),
        "--base-url",
        escapeShellArg(snapshot.baseUrl),
        "--api-key",
        escapeShellArg(snapshot.apiKey),
    ].join(" ");
    return {
        command: command.replace(/cua\.sh\s+run(\s|$)/, (_match, suffix) => `cua.sh run ${injectedFlags}${suffix}`),
        injected: true,
        reason: "captured",
    };
}
export function resetSessionModelCacheForTests() {
    sessionModelCache.clear();
}
//# sourceMappingURL=cua-session-model.js.map