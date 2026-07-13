import { test } from "node:test";
import assert from "node:assert/strict";

let buildSessionMessages;
let importError;
try {
  ({ buildSessionMessages } = await import("../messages.js"));
} catch (e) {
  importError = e;
}

const skipIfNoSdk = { skip: importError ? "openclaw/plugin-sdk not installed in this env" : false };

test("buildSessionMessages: 空数组返回空数组", skipIfNoSdk, () => {
  assert.deepEqual(buildSessionMessages([], 10, 100), []);
  assert.deepEqual(buildSessionMessages(undefined, 10, 100), []);
});

test("buildSessionMessages: 仅 user 消息保留为单回合", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [{ role: "user", content: "hello" }],
    10,
    100,
  );
  assert.deepEqual(out, [{ role: "user", text: "hello" }]);
});

test("buildSessionMessages: 顺序成对 user/assistant 形成回合", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ],
    10,
    100,
  );
  assert.deepEqual(out, [
    { role: "user", text: "q1" },
    { role: "assistant", text: "a1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ]);
});

test("buildSessionMessages: 没有 user 时丢弃 assistant", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ],
    10,
    100,
  );
  assert.deepEqual(out, [
    { role: "user", text: "q" },
    { role: "assistant", text: "a" },
  ]);
});

test("buildSessionMessages: 同一 user 出现两次会 flush 第一回合", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ],
    10,
    100,
  );
  assert.deepEqual(out, [
    { role: "user", text: "q1" },
    { role: "user", text: "q2" },
    { role: "assistant", text: "a2" },
  ]);
});

test("buildSessionMessages: maxMessagesPerSession 截尾", skipIfNoSdk, () => {
  const history = [];
  for (let i = 0; i < 5; i++) {
    history.push({ role: "user", content: `u${i}` });
    history.push({ role: "assistant", content: `a${i}` });
  }
  const out = buildSessionMessages(history, 4, 100);
  assert.equal(out.length, 4);
  assert.deepEqual(out, [
    { role: "user", text: "u3" },
    { role: "assistant", text: "a3" },
    { role: "user", text: "u4" },
    { role: "assistant", text: "a4" },
  ]);
});

test("buildSessionMessages: maxCharsPerMessage 截断长字符串", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      { role: "user", content: "abcdefghij" },
      { role: "assistant", content: "1234567890" },
    ],
    10,
    4,
  );
  assert.deepEqual(out, [
    { role: "user", text: "abcd" },
    { role: "assistant", text: "1234" },
  ]);
});

test("buildSessionMessages: 支持数组形式 content（仅取 text 块）", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", url: "x" },
          { type: "text", text: "world" },
        ],
      },
    ],
    10,
    100,
  );
  assert.deepEqual(out, [{ role: "user", text: "hello\nworld" }]);
});

test("buildSessionMessages: user 文本剥离 Sender 元数据 / 方括号前缀", skipIfNoSdk, () => {
  const userText = [
    "Sender (untrusted metadata): ```json",
    '{"name":"x"}',
    "```",
    "[user] real question",
  ].join("\n");
  const out = buildSessionMessages(
    [{ role: "user", content: userText }],
    10,
    100,
  );
  assert.deepEqual(out, [{ role: "user", text: "real question" }]);
});

test("buildSessionMessages: assistant 文本仅保留 [[reply_to_current]] 之后", skipIfNoSdk, () => {
  const out = buildSessionMessages(
    [
      { role: "user", content: "q" },
      { role: "assistant", content: "internal thoughts [[reply_to_current]] visible reply" },
    ],
    10,
    100,
  );
  assert.deepEqual(out, [
    { role: "user", text: "visible reply" },
  ]);
});
