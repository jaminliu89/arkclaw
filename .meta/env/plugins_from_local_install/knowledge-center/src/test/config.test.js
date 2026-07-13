import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveConfig } from "../config.js";

test("resolveConfig: 空入参返回默认值", () => {
  const cfg = resolveConfig();
  assert.equal(cfg.maxMessagesPerSession, 40);
  assert.equal(cfg.maxCharsPerMessage, 1000);
  assert.equal(cfg.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(typeof cfg.storeDirPath, "string");
  assert.ok(cfg.storeDirPath.length > 0);
});

test("resolveConfig: 自定义合法值会被采用并向下取整", () => {
  const cfg = resolveConfig({
    maxMessagesPerSession: 12.7,
    maxCharsPerMessage: 256.9,
    sessionTtlDays: 3,
  });
  assert.equal(cfg.maxMessagesPerSession, 12);
  assert.equal(cfg.maxCharsPerMessage, 256);
  assert.equal(cfg.sessionTtlMs, 3 * 24 * 60 * 60 * 1000);
});

test("resolveConfig: 非法值（0、负数、字符串）回退为默认", () => {
  const cfg = resolveConfig({
    maxMessagesPerSession: 0,
    maxCharsPerMessage: -10,
    sessionTtlDays: "abc",
  });
  assert.equal(cfg.maxMessagesPerSession, 40);
  assert.equal(cfg.maxCharsPerMessage, 1000);
  assert.equal(cfg.sessionTtlMs, 7 * 24 * 60 * 60 * 1000);
});
