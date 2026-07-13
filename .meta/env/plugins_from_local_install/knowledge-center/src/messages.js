import { stripReasoningTagsFromText } from "openclaw/plugin-sdk/text-runtime";

function normalizeRole(msg) {
  if (!msg || typeof msg !== "object") return "";
  return typeof msg.role === "string" ? msg.role.trim().toLowerCase() : "";
}

function sanitizeAndTruncateText(text, maxCharsPerMessage) {
  const cleaned = stripReasoningTagsFromText(String(text ?? "")).trim();
  return cleaned.length > maxCharsPerMessage ? cleaned.slice(0, maxCharsPerMessage) : cleaned;
}

function extractTextFromContent(content) {
  if (typeof content === "string") return String(content).trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function toStorageText(content, role, maxCharsPerMessage) {
  const raw = extractTextFromContent(content);
  let out = raw;

  if (role === "user") {
    out = out.replace(
      /^Sender\s*\(untrusted metadata\):\s*```json[\s\S]*?```\s*/i,
      "",
    );
    out = out.replace(/^\[[^\]]+\]\s*/i, "");
  } else if (role === "assistant" || role === "model") {
    const marker = "[[reply_to_current]]";
    const idx = out.indexOf(marker);
    if (idx >= 0) out = out.slice(idx + marker.length);
  }

  return sanitizeAndTruncateText(out, maxCharsPerMessage);
}

export function buildSessionMessages(historyMessages, maxMessagesPerSession, maxCharsPerMessage) {
  if (!Array.isArray(historyMessages) || historyMessages.length === 0) return [];
  const rows = [];
  let pendingUser = "";
  let pendingAssistant = "";

  const flushTurn = () => {
    if (!pendingUser) {
      pendingAssistant = "";
      return;
    }
    rows.push({ role: "user", text: pendingUser });
    if (pendingAssistant) rows.push({ role: "assistant", text: pendingAssistant });
    pendingUser = "";
    pendingAssistant = "";
  };

  for (const msg of historyMessages) {
    const role = normalizeRole(msg);
    if (role !== "user" && role !== "assistant" && role !== "model") continue;

    if (role === "user") {
      flushTurn();
      pendingUser = toStorageText(msg.content, "user", maxCharsPerMessage);
      continue;
    }

    if (!pendingUser) continue;
    const assistantText = toStorageText(msg.content, role, maxCharsPerMessage);
    if (!assistantText) continue;
    pendingAssistant = assistantText;
  }
  flushTurn();
  return rows.slice(-maxMessagesPerSession);
}
