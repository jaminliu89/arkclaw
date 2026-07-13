import os from "node:os";
import path from "node:path";

const DEFAULT_STORE_DIR_PATH = path.join(os.homedir(), ".openclaw", "runtime", "knowledge-center");
const DEFAULT_SESSION_TTL_DAYS = 7;
const DEFAULT_MAX_MESSAGES_PER_SESSION = 40;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 1000;

export function resolveConfig(pluginConfig) {
  const c = pluginConfig ?? {};
  const sessionTtlDays = typeof c.sessionTtlDays === "number" && c.sessionTtlDays > 0 ? c.sessionTtlDays : DEFAULT_SESSION_TTL_DAYS;

  return {
    storeDirPath: DEFAULT_STORE_DIR_PATH,
    maxMessagesPerSession:
      typeof c.maxMessagesPerSession === "number" && c.maxMessagesPerSession > 0
        ? Math.floor(c.maxMessagesPerSession)
        : DEFAULT_MAX_MESSAGES_PER_SESSION,
    maxCharsPerMessage:
      typeof c.maxCharsPerMessage === "number" && c.maxCharsPerMessage > 0
        ? Math.floor(c.maxCharsPerMessage)
        : DEFAULT_MAX_CHARS_PER_MESSAGE,
    sessionTtlMs: sessionTtlDays * 24 * 60 * 60 * 1000,
  };
}
