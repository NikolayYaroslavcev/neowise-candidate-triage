import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

export const MODEL_TIMEOUT_MS = 300;
const TOPICS = ["delivery", "pricing", "other"];
const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Request text, or null for missing, non-string, blank input or broken JSON.
async function readText(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const text = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

// The model gets MODEL_TIMEOUT_MS; the race also covers a provider that ignores the signal.
function callModel(text) {
  const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const aborted = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([classify(text, { signal }), aborted]);
}

// The only place model output is trusted: valid JSON, a known topic, a non-blank draft.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!TOPICS.includes(data?.topic)) return null;
  if (typeof data.draft !== "string" || !data.draft.trim()) return null;
  return { topic: data.topic, draft: data.draft };
}

async function handleTriage(request, response) {
  const text = await readText(request);
  if (text === null) return json(response, 400, INVALID_INPUT);

  let result = null;
  try {
    result = parseModelOutput(await callModel(text));
  } catch (error) {
    console.error("triage: model call failed:", error?.name ?? error);
  }
  if (!result) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...result });
}

export const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
