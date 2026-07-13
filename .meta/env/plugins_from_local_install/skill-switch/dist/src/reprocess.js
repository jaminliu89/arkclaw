export async function triggerReprocess(api, _contextKey, userMessage) {
    const messageText = extractTextFromMessage(userMessage);
    if (!messageText.trim()) {
        return;
    }
    try {
        await api.runtime.subagent?.run({
            sessionKey: `skill-switch-reprocess-${Date.now()}`,
            message: messageText,
        });
    }
    catch {
    }
}
function extractTextFromMessage(message) {
    if (!("content" in message)) {
        return "";
    }
    const content = message.content;
    if (typeof content === "string") {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    }
    return "";
}
//# sourceMappingURL=reprocess.js.map