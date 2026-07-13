export function getNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}
export function resolveSessionId(...sources) {
    for (const src of sources) {
        const found = getNonEmptyString(src?.sessionKey)
            ?? getNonEmptyString(src?.sessionId)
            // Backward-compatible fallback: some runtimes still expose session on ctx
            ?? getNonEmptyString(src?.session)
            ?? getNonEmptyString(src?.params?.sessionKey)
            ?? getNonEmptyString(src?.params?.sessionId);
        if (found)
            return found;
    }
    return null;
}
export const resolveSessionKey = resolveSessionId;
export function parseSessionKeyFromArgs(rawArgs) {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return null;
    }
    let sessionKey = null;
    const parts = trimmed.split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (part === "--session" || part === "-s") {
            sessionKey = parts[++i] ?? null;
            continue;
        }
        if (part.startsWith("--session=")) {
            sessionKey = part.slice("--session=".length) || null;
            continue;
        }
        if (part.startsWith("-s=")) {
            sessionKey = part.slice("-s=".length) || null;
            continue;
        }
        // Positional: `/cmd <sessionKey>`
        if (!sessionKey && !part.startsWith("-")) {
            sessionKey = part;
        }
    }
    return sessionKey;
}
//# sourceMappingURL=utils.js.map