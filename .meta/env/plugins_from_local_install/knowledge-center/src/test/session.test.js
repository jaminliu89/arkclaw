import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveSessionKey } from "../session.js";

test("resolveSessionKey: 优先取 ctx.sessionKey", () => {
  assert.equal(
    resolveSessionKey({ sessionKey: "from-event" }, { sessionKey: "from-ctx" }),
    "from-ctx",
  );
});

test("resolveSessionKey: ctx 缺失时退化到 event.sessionKey", () => {
  assert.equal(resolveSessionKey({ sessionKey: "from-event" }, undefined), "from-event");
  assert.equal(resolveSessionKey({ sessionKey: "from-event" }, {}), "from-event");
});

test("resolveSessionKey: 都没有时返回空字符串", () => {
  assert.equal(resolveSessionKey({}, {}), "");
  assert.equal(resolveSessionKey(undefined, undefined), "");
});
