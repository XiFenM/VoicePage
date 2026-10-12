/**
 * Local-only ZenMux fixture for progress/error testing. No external requests.
 *
 * Run: node scripts/mock-zenmux.mjs
 * App: ZENMUX_BASE_URL=http://127.0.0.1:4319/api/v1 ZENMUX_API_KEY=test
 * Use a separate DATA_DIR and test login credentials when starting the app.
 *
 * Markers in source text (preserved in the fake spoken script):
 *   MOCK_LLM_ERROR / MOCK_LLM_RETRY / MOCK_TAG_ERROR / MOCK_TAG_RETRY
 *   MOCK_TTS_ERROR / MOCK_TTS_RETRY
 *   MOCK_{LLM|TAG|TTS}_NETWORK_ONCE (destroy the socket without a response)
 *   MOCK_{LLM|TAG|TTS}_HTTP_{400|403}_ONCE (permanent HTTP failure once)
 *   MOCK_{LLM|TAG|TTS}_HTTP_503_THREE (fail three requests, then succeed)
 *   MOCK_SLOW_SPOKEN (20s) / MOCK_SLOW_TAGS (20s) / MOCK_SLOW_TTS (12s)
 * *_RETRY markers fail once per distinct input, then succeed.
 * Add MOCK_CASE_example to correlate a segment's tag and TTS requests in logs.
 * Add the same MOCK_DOC_example marker to every segment to measure active docs.
 * GET /__mock/status returns stage timings/counts and synthetic case IDs only.
 *
 * Import createMockZenmux({ spokenMs, tagsMs, speechMs }) for faster API tests.
 */
import http from "node:http";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";

function waitForResponse(ms, response) {
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      response.removeListener("close", onClose);
      resolve(!response.destroyed);
    }, ms);
    response.once("close", onClose);
  });
}

function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function failure(response, stage, status = 503) {
  json(response, status, {
    error: { code: "mock_failure", type: "mock_failure", message: `模拟 ${stage} HTTP ${status} 失败` },
  });
}

function makePcm() {
  // Quiet sine wave, long enough to verify playback before other segments finish.
  const sampleRate = 24000;
  const samples = sampleRate * 3;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / 1000, (samples - i - 1) / 1000);
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 900 * envelope), i * 2);
  }
  return pcm.toString("base64");
}

export function createMockZenmux({ spokenMs = 2500, tagsMs = 7000, speechMs = 5000, slowSpokenMs = 20000, slowTagsMs = 20000, slowSpeechMs = 12000 } = {}) {
  const events = [];
  const changes = new EventEmitter();
  const attempts = new Map();
  const audio = makePcm();
  let requestId = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let activeTextRequests = 0;
  let activeTtsRequests = 0;
  let maxTextRequests = 0;
  let maxTtsRequests = 0;
  let maxActiveDocuments = 0;
  const activeEvents = new Map();
  const activeDocumentKeys = () => [...new Set([...activeEvents.values()].flatMap((event) => event.documents))];
  const stats = () => ({ activeRequests, maxActiveRequests, activeTextRequests, activeTtsRequests, maxTextRequests, maxTtsRequests, activeDocuments: activeDocumentKeys().length, maxActiveDocuments });

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (request.method === "GET" && pathname === "/__mock/status") {
      return json(response, 200, { fixture: "voicepage-local-zenmux", ...stats(), events });
    }
    if (request.method !== "POST" || !["/api/v1/chat/completions", "/api/v1/audio/speech"].includes(pathname)) {
      return json(response, 404, { error: "Unknown mock endpoint" });
    }

    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) return json(response, 413, { error: "Mock request too large" });
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(response, 400, { error: "Invalid mock JSON" });
    }

    const isSpeech = pathname.endsWith("/audio/speech");
    const isTags = !isSpeech && body.messages?.some((message) => message.role === "system" && message.content.includes("你是语音导演"));
    const stage = isSpeech ? "tts" : isTags ? "tags" : "spoken";
    const input = isSpeech ? String(body.input ?? "") : body.messages?.find((message) => message.role === "user")?.content ?? "";
    const cases = [...new Set(input.match(/MOCK_CASE_[a-zA-Z0-9_]+/g) ?? [])];
    const documents = [...new Set(input.match(/MOCK_DOC_[a-zA-Z0-9_]+/g) ?? [])];
    const event = { id: ++requestId, stage, cases, documents, startedAt: Date.now(), finishedAt: null, status: "running" };
    events.push(event);
    if (events.length > 1000) events.shift();
    activeRequests++;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    if (isSpeech) activeTtsRequests++;
    else activeTextRequests++;
    maxTextRequests = Math.max(maxTextRequests, activeTextRequests);
    maxTtsRequests = Math.max(maxTtsRequests, activeTtsRequests);
    activeEvents.set(event.id, event);
    maxActiveDocuments = Math.max(maxActiveDocuments, activeDocumentKeys().length);
    event.activeAtStart = stats();
    changes.emit("change", event);
    const attemptKey = `${stage}:${input}`;
    const attempt = (attempts.get(attemptKey) ?? 0) + 1;
    attempts.set(attemptKey, attempt);
    const delay = isSpeech ? (input.includes("MOCK_SLOW_TTS") ? slowSpeechMs : speechMs) : isTags ? (input.includes("MOCK_SLOW_TAGS") ? slowTagsMs : tagsMs) : (input.includes("MOCK_SLOW_SPOKEN") ? slowSpokenMs : spokenMs);
    const connected = await waitForResponse(delay, response);
    event.finishedAt = Date.now();
    activeRequests--;
    if (isSpeech) activeTtsRequests--;
    else activeTextRequests--;
    activeEvents.delete(event.id);
    if (!connected) {
      event.status = "cancelled";
      changes.emit("change", event);
      return;
    }

    const prefix = stage === "spoken" ? "LLM" : stage === "tags" ? "TAG" : "TTS";
    const networkFailure = input.includes(`MOCK_${prefix}_NETWORK_ALWAYS`) || (input.includes(`MOCK_${prefix}_NETWORK_ONCE`) && attempt === 1);
    const permanentStatus = [400, 403].find((status) => input.includes(`MOCK_${prefix}_HTTP_${status}_ALWAYS`) || (input.includes(`MOCK_${prefix}_HTTP_${status}_ONCE`) && attempt === 1));
    const shouldFail = permanentStatus || (input.includes(`MOCK_${prefix}_HTTP_503_THREE`) && attempt <= 3) || (stage === "spoken" && (input.includes("MOCK_LLM_ERROR") || (input.includes("MOCK_LLM_RETRY") && attempt === 1))) ||
      (stage === "tags" && (input.includes("MOCK_TAG_ERROR") || (input.includes("MOCK_TAG_RETRY") && attempt === 1))) ||
      (isSpeech && (input.includes("MOCK_TTS_ERROR") || (input.includes("MOCK_TTS_RETRY") && attempt === 1)));
    if (networkFailure) {
      event.status = "failed";
      event.failureKind = "network";
      changes.emit("change", event);
      request.socket.destroy();
      return;
    }
    if (shouldFail) {
      event.status = "failed";
      event.httpStatus = permanentStatus ?? 503;
      response.setHeader("X-ZenMux-RequestId", `mock-${stage}-${event.id}`);
      changes.emit("change", event);
      return failure(response, stage, event.httpStatus);
    }

    try {
      if (isSpeech) {
        event.status = "complete";
        changes.emit("change", event);
        return json(response, 200, { audio, mime_type: "audio/L16;rate=24000", usage: { total_tokens: 1 } });
      }

      const systemPrompt = body.messages?.find((message) => message.role === "system")?.content ?? "";
      const tag = systemPrompt.match(/(?:<[^<>\n]+>|\[[^\[\]\n]+\])(?=（)/)?.[0] ?? "";
      const segments = isTags
        ? JSON.parse(input).segments.map((segment) => ({ ...segment, speech: `${tag}${segment.speech}` }))
        : [...input.matchAll(/<block id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/block>/g)].map(([, id, markdown]) => ({
          id: Number(id),
          speech: markdown.replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim(),
        }));
      event.status = "complete";
      changes.emit("change", event);
      return json(response, 200, { choices: [{ message: { role: "assistant", content: JSON.stringify({ segments }) } }] });
    } catch {
      event.status = "failed";
      changes.emit("change", event);
      return json(response, 400, { error: { type: "mock_input", message: "Unrecognized mock prompt" } });
    }
  });
  return { server, events, changes, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_ZENMUX_PORT ?? 4319);
  const { server } = createMockZenmux({
    spokenMs: Number(process.env.MOCK_SPOKEN_MS ?? 2500),
    tagsMs: Number(process.env.MOCK_TAGS_MS ?? 7000),
    speechMs: Number(process.env.MOCK_SPEECH_MS ?? 5000),
    slowSpokenMs: Number(process.env.MOCK_SLOW_SPOKEN_MS ?? 20000),
    slowTagsMs: Number(process.env.MOCK_SLOW_TAGS_MS ?? 20000),
    slowSpeechMs: Number(process.env.MOCK_SLOW_SPEECH_MS ?? 12000),
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Local mock ZenMux: http://127.0.0.1:${port}/api/v1`);
  });
}
