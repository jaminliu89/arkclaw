import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveConfig } from "./src/config.js";
import { buildSessionMessages } from "./src/messages.js";
import { cleanupExpiredSessionFiles, enqueueWrite, getSessionFilePath, writeJsonAtomic } from "./src/storage.js";
import { resolveSessionKey } from "./src/session.js";

export default definePluginEntry({
  id: "knowledge-center",
  name: "knowledge-center",
  version: "1.0.3",
  description: "Record user and assistant visible text by session into per-session JSON files",
  register(api) {
    const cfg = resolveConfig(api.pluginConfig);

    api.on("llm_input", async (event, ctx) => {
      const sessionKey = resolveSessionKey(event, ctx);
      if (!sessionKey) return;
      const messages = buildSessionMessages(event?.historyMessages, cfg.maxMessagesPerSession, cfg.maxCharsPerMessage);
      await enqueueWrite(async () => {
        await cleanupExpiredSessionFiles(cfg.storeDirPath, cfg.sessionTtlMs);
        const sessionFilePath = getSessionFilePath(cfg.storeDirPath, sessionKey);
        await writeJsonAtomic(sessionFilePath, messages);
      });
    });
  },
});
