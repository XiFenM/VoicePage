// Shared local-only fixture for HTTP integration scripts. Never copies .env/data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createMockZenmux } from "./mock-zenmux.mjs";

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(predicate, message, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}

export async function createFixture(name, mockOptions = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = fs.mkdtempSync(path.join(os.homedir(), `voicepage-${name}-`));
  const dataDir = path.join(dir, "data");
  for (const item of ["src", "public", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
    if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(dir, item), { recursive: true });
  }
  let commonRoot = root;
  while (!dir.startsWith(`${commonRoot}${path.sep}`)) {
    const parent = path.dirname(commonRoot);
    if (parent === commonRoot) break;
    commonRoot = parent;
  }
  fs.writeFileSync(path.join(dir, "next.config.ts"), fs.readFileSync(path.join(root, "next.config.ts"), "utf8").replace("turbopack: {", `turbopack: {\n    root: ${JSON.stringify(commonRoot)},`));
  fs.symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  assert.ok(!fs.readdirSync(dir).some((item) => item.startsWith(".env")));
  const mock = createMockZenmux(mockOptions);
  await new Promise((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
  const reserve = net.createServer();
  await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const app = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, DATA_DIR: dataDir, ZENMUX_BASE_URL: `http://127.0.0.1:${mock.server.address().port}/api/v1`,
    ZENMUX_API_KEY: "voicepage-local-mock", SCRIPT_MODEL: "local/mock", APP_PASSWORD: "voicepage-test",
    SESSION_SECRET: "voicepage-test-session-secret", BACKGROUND_LEASE_MS: "6000",
  };
  delete env.BACKGROUND_WORKER_DISABLED;
  delete env.NEXT_PHASE;
  let processRef;
  let cookie = "";
  let logs = "";
  let database;

  async function start() {
    processRef = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: dir, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Next startup timed out: ${logs}`)), 60000);
      const output = (chunk) => {
        logs = `${logs}${chunk}`.slice(-50000);
        if (String(chunk).includes("Ready in")) { clearTimeout(timeout); resolve(); }
      };
      processRef.stdout.on("data", output);
      processRef.stderr.on("data", output);
      processRef.once("error", reject);
      processRef.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Next exited (${code}): ${logs}`)); });
    });
  }
  async function stopServer(signal = "SIGTERM") {
    if (!processRef || processRef.exitCode !== null || processRef.signalCode !== null) return;
    const exited = once(processRef, "exit");
    if (process.platform === "win32") processRef.kill(signal);
    else process.kill(-processRef.pid, signal);
    await exited;
  }
  async function raw(endpoint, init = {}) {
    return fetch(`${app}${endpoint}`, { ...init, headers: { Cookie: cookie, Connection: "close", ...init.headers }, signal: AbortSignal.timeout(30000) });
  }
  async function request(endpoint, method = "GET", body) {
    const response = await raw(endpoint, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function close() {
    await stopServer();
    database?.close();
    mock.server.closeAllConnections();
    await new Promise((resolve) => mock.server.close(resolve));
    fs.writeFileSync(path.join(dir, "next-test.log"), logs);
    fs.writeFileSync(path.join(dir, "mock-events.json"), JSON.stringify(mock.events, null, 2));
    console.log(`Kept isolated fixture: ${dir}`);
  }
  try {
    await start();
    const login = await raw("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "voicepage-test" }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie").split(";")[0];
    database = new DatabaseSync(path.join(dataDir, "readaloud.db"), { readOnly: true });
    console.log(JSON.stringify({ fixture: dir, app, model: env.SCRIPT_MODEL }));
    return { dir, dataDir, app, mock, database, request, raw, close, restart: async () => { await stopServer("SIGKILL"); await start(); } };
  } catch (error) {
    await close();
    throw error;
  }
}
