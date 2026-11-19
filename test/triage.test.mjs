import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server, MODEL_TIMEOUT_MS } from "../server.mjs";

let url;
before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/api/triage`;
});
after(() => server.close());

async function triage(body) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

test("valid request returns topic and draft", async () => {
  const { status, body } = await triage({ text: "Когда будет доставка?" });
  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.ok(body.draft.trim());
});

for (const tag of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${tag} falls back to manual review`, async () => {
    const { status, body } = await triage({ text: `Сколько стоит? ${tag}` });
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL_REVIEW);
  });
}

test("model timeout falls back to manual review within the limit", async () => {
  const started = performance.now();
  const { status, body } = await triage({ text: "Где заказ? [timeout]" });
  assert.equal(status, 200);
  assert.deepEqual(body, MANUAL_REVIEW);
  assert.ok(performance.now() - started < MODEL_TIMEOUT_MS + 500, "did not wait for the slow model");
});

for (const [name, body] of [
  ["empty text", { text: "" }],
  ["blank text", { text: "   " }],
  ["missing text", {}],
  ["non-string text", { text: 42 }],
  ["null body", "null"],
  ["broken JSON", "{text:"],
]) {
  test(`${name} is rejected with 400`, async () => {
    const reply = await triage(body);
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, { status: "invalid_input" });
  });
}
