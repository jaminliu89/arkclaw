import path from "node:path";
import { promises as fs } from "node:fs";

const WRITE_QUEUE = { current: Promise.resolve() };

async function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

export function sessionKeyToFileName(sessionKey) {
  return `${String(sessionKey)}.json`;
}

export function getSessionFilePath(storeDirPath, sessionKey) {
  return path.join(storeDirPath, sessionKeyToFileName(sessionKey));
}

export async function writeJsonAtomic(filePath, value) {
  await ensureParentDir(filePath);
  const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpFile, filePath);
}

export function enqueueWrite(task) {
  WRITE_QUEUE.current = WRITE_QUEUE.current.then(task, task);
  return WRITE_QUEUE.current;
}

export async function cleanupExpiredSessionFiles(storeDirPath, maxAgeMs) {
  const now = Date.now();
  let entries = [];
  try {
    entries = await fs.readdir(storeDirPath, { withFileTypes: true });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return;
    throw e;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(storeDirPath, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.unlink(filePath);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e.code === "ENOENT" || e.code === "ENOTDIR")) continue;
      throw e;
    }
  }
}
