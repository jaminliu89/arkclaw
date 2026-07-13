import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import {
  cleanupExpiredSessionFiles,
  enqueueWrite,
  getSessionFilePath,
  sessionKeyToFileName,
  writeJsonAtomic,
} from "../storage.js";

async function makeTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "kc-storage-"));
}

test("sessionKeyToFileName: 拼接 .json 后缀", () => {
  assert.equal(sessionKeyToFileName("abc"), "abc.json");
  assert.equal(sessionKeyToFileName(123), "123.json");
});

test("getSessionFilePath: 拼接目录与文件名", () => {
  assert.equal(getSessionFilePath("/tmp/x", "k"), path.join("/tmp/x", "k.json"));
});

test("writeJsonAtomic: 写入并可读回，目录不存在时自动创建", async () => {
  const dir = await makeTmpDir();
  const file = path.join(dir, "nested", "deep", "out.json");
  const value = { a: 1, b: ["x", "y"] };
  await writeJsonAtomic(file, value);
  const txt = await fs.readFile(file, "utf8");
  assert.deepEqual(JSON.parse(txt), value);
  await fs.rm(dir, { recursive: true, force: true });
});

test("enqueueWrite: 串行执行任务，按入队顺序输出", async () => {
  const order = [];
  const t1 = enqueueWrite(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push("a");
  });
  const t2 = enqueueWrite(async () => {
    order.push("b");
  });
  const t3 = enqueueWrite(async () => {
    order.push("c");
  });
  await Promise.all([t1, t2, t3]);
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("cleanupExpiredSessionFiles: 删除过期 .json，保留新鲜 .json，忽略其他后缀", async () => {
  const dir = await makeTmpDir();
  const fresh = path.join(dir, "fresh.json");
  const stale = path.join(dir, "stale.json");
  const other = path.join(dir, "keep.txt");

  await fs.writeFile(fresh, "{}");
  await fs.writeFile(stale, "{}");
  await fs.writeFile(other, "x");

  const longAgo = Date.now() / 1000 - 60 * 60 * 24 * 30;
  await fs.utimes(stale, longAgo, longAgo);

  await cleanupExpiredSessionFiles(dir, 60 * 1000);

  assert.ok(
    await fs
      .stat(fresh)
      .then(() => true)
      .catch(() => false),
    "fresh.json should remain",
  );
  assert.ok(
    await fs
      .stat(other)
      .then(() => true)
      .catch(() => false),
    "non-json should remain",
  );
  const staleExists = await fs
    .stat(stale)
    .then(() => true)
    .catch(() => false);
  assert.equal(staleExists, false, "stale.json should be removed");

  await fs.rm(dir, { recursive: true, force: true });
});

test("cleanupExpiredSessionFiles: 目录不存在时静默返回", async () => {
  await cleanupExpiredSessionFiles(path.join(os.tmpdir(), `kc-not-exist-${Date.now()}`), 1000);
});
