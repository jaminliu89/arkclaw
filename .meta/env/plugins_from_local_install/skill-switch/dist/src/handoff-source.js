const SOURCE_TTL_MS = 10 * 60_000;
const handoffSourceBySession = new Map();
function purgeExpired() {
    const now = Date.now();
    for (const [sessionKey, entry] of handoffSourceBySession) {
        if (entry.expiresAt <= now) {
            handoffSourceBySession.delete(sessionKey);
        }
    }
}
export function markHandoffSource(sessionKey, source, mtimeMs) {
    if (!sessionKey)
        return;
    purgeExpired();
    handoffSourceBySession.set(sessionKey, {
        source,
        mtimeMs,
        expiresAt: Date.now() + SOURCE_TTL_MS,
    });
}
export function getRecentHandoffSource(sessionKey) {
    if (!sessionKey)
        return null;
    const entry = handoffSourceBySession.get(sessionKey);
    if (!entry)
        return null;
    if (entry.expiresAt <= Date.now()) {
        handoffSourceBySession.delete(sessionKey);
        return null;
    }
    return entry.source;
}
export function consumeRecentHandoffSource(sessionKey) {
    const source = getRecentHandoffSource(sessionKey);
    if (source)
        handoffSourceBySession.delete(sessionKey);
    return source;
}
export function _clearHandoffSourcesForTest() {
    handoffSourceBySession.clear();
}
//# sourceMappingURL=handoff-source.js.map