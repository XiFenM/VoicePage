import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_LOG_BYTES = 64 * 1024;
export const MAX_LOG_FILES = 8;
const owned = new Map();

function directory(location) {
  fs.mkdirSync(location, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(location);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe QA directory: ${location}`);
  return fs.realpathSync(location);
}

function redact(value) {
  let text = String(value);
  for (const key of ["ZENMUX_API_KEY", "APP_PASSWORD", "SESSION_SECRET"]) {
    const secret = process.env[key];
    if (secret && secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[redacted]");
}

function tail(text, bytes) {
  return Buffer.from(text).subarray(-bytes).toString("utf8");
}

function diagnostic(value) {
  const text = redact(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (Buffer.byteLength(text) <= MAX_LOG_BYTES) return text;
  // Object logs remain valid JSON even when only their tail can be retained.
  return typeof value === "string"
    ? `[truncated; last output follows]\n${tail(text, MAX_LOG_BYTES - 128)}`
    : JSON.stringify({ truncated: true, tail: tail(text, Math.floor(MAX_LOG_BYTES / 3)) }, null, 2);
}

function assertOwned(dir) {
  const owner = owned.get(dir);
  if (!owner || fs.realpathSync(path.dirname(dir)) !== owner.parent) throw new Error(`Refusing to clean an unowned QA directory: ${dir}`);
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== owner.dev || stat.ino !== owner.ino) {
    throw new Error(`QA directory identity changed: ${dir}`);
  }
}

/** All test/build copies live in the system temp tree, never in the user's home. */
export function createQaWorkspace(name) {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("Invalid QA workspace name");
  const base = directory(path.join(fs.realpathSync(os.tmpdir()), "voicepage-tests"));
  const parent = directory(path.join(base, "workspaces"));
  const dir = fs.mkdtempSync(path.join(parent, `${name}-`));
  const stat = fs.lstatSync(dir);
  owned.set(dir, { parent, dev: stat.dev, ino: stat.ino });
  let finished = false;
  let retained;
  return Object.freeze({
    dir,
    /** Call only after closing this fixture's children, listeners and database. */
    finish({ success, error, logs = {} }) {
      if (finished) return retained;
      if (typeof success !== "boolean") throw new Error("QA outcome must be explicit");
      const entries = Object.entries(logs);
      if (entries.length > MAX_LOG_FILES || entries.some(([file]) => file === "failure.json" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(log|txt|json)$/.test(file))) {
        throw new Error("Invalid QA diagnostic log names/count");
      }
      assertOwned(dir);
      try {
        if (!success) {
          const failures = directory(path.join(base, "failures"));
          retained = fs.mkdtempSync(path.join(failures, `${name}-`));
          const reason = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error ?? "Test did not complete successfully") };
          fs.writeFileSync(path.join(retained, "failure.json"), diagnostic({ test: name, finishedAt: new Date().toISOString(), workspace: dir, error: reason }), { mode: 0o600 });
          for (const [file, value] of entries) fs.writeFileSync(path.join(retained, file), diagnostic(value), { mode: 0o600 });
        }
      } finally {
        // Disk-full/serialization errors must not leave large builds or databases behind.
        // Recheck identity after logging, then unlink nested symlinks without following them.
        assertOwned(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        owned.delete(dir);
        finished = true;
      }
      if (retained) console.error(`QA failed; diagnostic logs retained: ${retained}`);
      else console.log(`Removed successful QA workspace: ${dir}`);
      return retained;
    },
  });
}

/** Copy only code/config and isolated dependencies; never import live env/data. */
export function prepareQaSource(root, dir) {
  assertOwned(dir);
  for (const item of ["src", "public", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
    if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(dir, item), { recursive: true });
  }
  const dependencies = fs.realpathSync(path.join(root, "node_modules"));
  // Clone files on supporting filesystems (e.g. APFS), otherwise copy them.
  // Preserve relative pnpm links inside the copy; external links are not followed.
  fs.cpSync(dependencies, path.join(dir, "node_modules"), {
    recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE,
  });
  const source = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
  const exportLine = "export default nextConfig;";
  if (!source.includes(exportLine)) throw new Error("Cannot apply isolated QA Next configuration");
  const config = source.replace(exportLine, `nextConfig.turbopack = { ...nextConfig.turbopack, root: ${JSON.stringify(dir)} };
${exportLine}`);
  fs.writeFileSync(path.join(dir, "next.config.ts"), config);
  if (fs.readdirSync(dir).some((item) => item.startsWith(".env"))) throw new Error("QA workspace must not contain environment files");
  const nextRoot = fs.realpathSync(path.join(dir, "node_modules/next"));
  // Mirror pnpm's Next shim using only the copied dependency tree. Its original
  // .bin script embeds absolute paths, while bare Node misses these lookup roots
  // when Turbopack loads an external runtime through node_modules/next.
  return {
    bin: path.join(nextRoot, "dist/bin/next"),
    nodePath: [path.join(nextRoot, "node_modules"), path.dirname(nextRoot), path.join(dir, "node_modules/.pnpm/node_modules")].join(path.delimiter),
  };
}

/** Stop only a child spawned by this test, including its detached process group. */
export async function stopQaProcess(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  const send = (sig) => {
    try {
      if (process.platform === "win32") {
        if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      } else process.kill(-child.pid, sig);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  const exists = () => {
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if (error.code === "ESRCH") return false;
      // A terminating macOS process group can briefly reject the zero-signal probe.
      // Keep waiting rather than failing cleanup before its grace period expires.
      if (error.code === "EPERM") return true;
      throw error;
    }
  };
  if (!exists()) return;
  send(signal);
  const wait = async (milliseconds) => {
    const until = Date.now() + milliseconds;
    while (exists() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    return !exists();
  };
  if (await wait(signal === "SIGKILL" ? 2_000 : 5_000)) return;
  send("SIGKILL");
  if (!await wait(2_000)) throw new Error(`QA process group ${child.pid} did not exit`);
}

export async function closeQaServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
