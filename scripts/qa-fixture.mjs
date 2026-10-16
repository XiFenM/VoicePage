// Shared local-only fixture for HTTP integration scripts. Never copies .env/data.
import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockZenmux } from "./mock-zenmux.mjs";
import { createQaWorkspace, prepareQaSource, stopQaProcess, closeQaServer } from "./qa-workspace.mjs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(predicate, message, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

export async function createFixture(name, mockOptions = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workspace = createQaWorkspace(name);
  const { dir } = workspace;
  const dataDir = path.join(dir, "data");
  let mock, reserve, processRef, database, env, port, app, nextRuntime;
  let cookie = "";
  let logs = "";
  let closing;

  function assertOpen() {
    if (closing) throw new Error("QA fixture is closing");
  }

  async function start() {
    assertOpen();
    processRef = spawn(process.execPath, [nextRuntime.bin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: dir, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const child = processRef;
    await new Promise((resolve, reject) => {
      let startupOutput = "";
      const timeout = setTimeout(() => reject(new Error("Next startup timed out")), 60000);
      const output = (chunk) => {
        logs = `${logs}${chunk}`.slice(-50000);
        startupOutput = `${startupOutput}${chunk}`.slice(-1000);
        if (startupOutput.includes("Ready in")) { clearTimeout(timeout); resolve(); }
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next exited (${code})`)); });
    });
    assertOpen();
  }

  async function raw(endpoint, init = {}) {
    return fetch(`${app}${endpoint}`, { ...init, headers: { Cookie: cookie, Connection: "close", ...init.headers }, signal: AbortSignal.timeout(30000) });
  }
  async function request(endpoint, method = "GET", body) {
    const response = await raw(endpoint, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }

  function close({ success = false, error } = {}) {
    if (closing) return closing;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    closing = (async () => {
      const cleanupErrors = [];
      for (const release of [
        () => stopQaProcess(processRef),
        () => { database?.close(); database = undefined; },
        () => closeQaServer(reserve),
        () => closeQaServer(mock?.server),
      ]) {
        try { await release(); } catch (failure) { cleanupErrors.push(failure); }
      }
      const outcome = error ?? (cleanupErrors.length ? new AggregateError(cleanupErrors, "QA resource cleanup failed") : undefined);
      try {
        const retained = workspace.finish({
          success: success && !outcome,
          error: outcome,
          logs: {
            "next-test.log": logs,
            "mock-events.json": mock?.events ?? [],
            ...(cleanupErrors.length ? { "cleanup-errors.log": cleanupErrors.map((failure) => failure.stack ?? String(failure)).join("\n") } : {}),
          },
        });
        if (!error && cleanupErrors.length) throw outcome;
        return retained;
      } catch (cleanupError) {
        if (!error) throw cleanupError;
        // The assertion/setup error must remain the primary failure.
        console.error("QA cleanup encountered an additional error while preserving diagnostics for:", dir);
        return undefined;
      }
    })();
    return closing;
  }

  function interrupted(signal, code) {
    void close({ success: false, error: new Error(`QA interrupted by ${signal}`) }).finally(() => process.exit(code));
  }
  const onInterrupt = () => interrupted("SIGINT", 130);
  const onTerminate = () => interrupted("SIGTERM", 143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  // Setup is inside the protected lifetime, including copying dependencies and binding ports.
  try {
    nextRuntime = prepareQaSource(root, dir);
    mock = createMockZenmux(mockOptions);
    await listen(mock.server);
    assertOpen();
    reserve = net.createServer();
    await listen(reserve);
    port = reserve.address().port;
    await closeQaServer(reserve);
    assertOpen();
    app = `http://127.0.0.1:${port}`;
    env = {
      ...process.env, DATA_DIR: dataDir, ZENMUX_BASE_URL: `http://127.0.0.1:${mock.server.address().port}/api/v1`,
      ZENMUX_API_KEY: "voicepage-local-mock", SCRIPT_MODEL: "local/mock", APP_PASSWORD: "voicepage-test",
      SESSION_SECRET: "voicepage-test-session-secret", BACKGROUND_LEASE_MS: "6000", NEXT_TELEMETRY_DISABLED: "1", NODE_PATH: nextRuntime.nodePath,
    };
    delete env.BACKGROUND_WORKER_DISABLED;
    delete env.NEXT_PHASE;
    delete env.NODE_ENV;
    await start();
    const login = await raw("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "voicepage-test" }) });
    assert.equal(login.status, 200);
    assertOpen();
    cookie = login.headers.get("set-cookie").split(";")[0];
    database = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
    console.log(JSON.stringify({ fixture: dir, app, model: env.SCRIPT_MODEL }));
    return { dir, dataDir, app, mock, database, request, raw, close,
      restart: async () => { await stopQaProcess(processRef, "SIGKILL"); await start(); } };
  } catch (error) {
    await close({ success: false, error });
    throw error;
  }
}
