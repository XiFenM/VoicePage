import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Give this test process its own temp root so retained failures never leak out
// of the test sandbox, and use a separate directory as a protected symlink target.
const originalTmp = process.env.TMPDIR;
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "voicepage-workspace-spec-"));
const protectedDir = fs.mkdtempSync(path.join(os.tmpdir(), "voicepage-protected-spec-"));
fs.writeFileSync(path.join(protectedDir, "must-survive.txt"), "protected dependency contents");
process.env.TMPDIR = sandbox;
const { createQaWorkspace, prepareQaSource, stopQaProcess, MAX_LOG_BYTES, MAX_LOG_FILES } = await import("../scripts/qa-workspace.mjs");
const { createFixture } = await import("../scripts/qa-fixture.mjs");
const qaRoot = path.join(fs.realpathSync(sandbox), "voicepage-tests");
const workspaceParent = path.join(qaRoot, "workspaces");
const failuresParent = path.join(qaRoot, "failures");
const list = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
const assertProtected = () => assert.equal(fs.readFileSync(path.join(protectedDir, "must-survive.txt"), "utf8"), "protected dependency contents");

after(() => {
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(protectedDir, { recursive: true, force: true });
});

function populate(workspace) {
  for (const dir of ["src", ".next", "data"]) fs.mkdirSync(path.join(workspace.dir, dir));
  fs.writeFileSync(path.join(workspace.dir, "src", "private.txt"), "SOURCE_MUST_NOT_BE_RETAINED");
  fs.writeFileSync(path.join(workspace.dir, ".next", "cache.bin"), "CACHE_MUST_NOT_BE_RETAINED");
  fs.writeFileSync(path.join(workspace.dir, "data", "readaloud.db"), "DATABASE_MUST_NOT_BE_RETAINED");
  fs.writeFileSync(path.join(workspace.dir, ".env.local"), "ENV_MUST_NOT_BE_RETAINED");
  fs.symlinkSync(protectedDir, path.join(workspace.dir, "node_modules"), "dir");
  fs.symlinkSync(protectedDir, path.join(workspace.dir, "data", "nested-link"), "dir");
}

test("successful cleanup removes only its workspace and never follows dependency/data symlinks", () => {
  const workspace = createQaWorkspace("success");
  const sibling = createQaWorkspace("sibling");
  populate(workspace);
  const priorFailures = list(failuresParent);
  assert.equal(path.dirname(workspace.dir), workspaceParent);
  assert.equal(workspace.finish({ success: true }), undefined);
  assert.equal(fs.existsSync(workspace.dir), false);
  assert.equal(fs.existsSync(sibling.dir), true);
  assert.deepEqual(list(failuresParent), priorFailures);
  assertProtected();
  sibling.finish({ success: true });
});

test("failure retains only explicitly supplied diagnostics plus metadata and removes all source/build/data", () => {
  const workspace = createQaWorkspace("failure");
  populate(workspace);
  const retained = workspace.finish({ success: false, error: new Error("intentional fixture failure"), logs: {
    "next-test.log": "necessary error summary",
    "mock-events.json": [{ stage: "spoken", status: "failed" }],
  } });
  assert.equal(path.dirname(retained), failuresParent);
  assert.equal(fs.existsSync(workspace.dir), false);
  assert.deepEqual(list(retained), ["failure.json", "mock-events.json", "next-test.log"]);
  assert.ok(list(retained).every((name) => fs.lstatSync(path.join(retained, name)).isFile()));
  const combined = list(retained).map((name) => fs.readFileSync(path.join(retained, name), "utf8")).join("\n");
  assert.match(combined, /intentional fixture failure/);
  for (const marker of ["SOURCE_MUST_NOT_BE_RETAINED", "CACHE_MUST_NOT_BE_RETAINED", "DATABASE_MUST_NOT_BE_RETAINED", "ENV_MUST_NOT_BE_RETAINED"]) assert.ok(!combined.includes(marker));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retained, "mock-events.json"), "utf8")), [{ stage: "spoken", status: "failed" }]);
  assertProtected();
});

test("workspace names reject traversal and malformed values before creating directories", () => {
  const previous = list(workspaceParent);
  for (const name of ["", ".", "..", "../escape", "a/b", "a\\b", "/absolute", "Uppercase", "bad name", "bad\0name", "a".repeat(65), undefined, null, 42]) {
    let unexpected;
    try {
      assert.throws(() => { unexpected = createQaWorkspace(name); }, /Invalid QA workspace name/, String(name));
    } finally {
      unexpected?.finish({ success: true });
    }
  }
  assert.deepEqual(list(workspaceParent), previous);
});

test("invalid diagnostic paths, reserved metadata names and excessive counts reject before writes or cleanup", () => {
  const workspace = createQaWorkspace("invalid-logs");
  const previous = list(failuresParent);
  for (const name of ["../escape.log", "nested/file.log", "nested\\file.log", "/absolute.log", "failure.json", ".hidden.log", "audio.mp3", "bad\0name.log"]) {
    assert.throws(() => workspace.finish({ success: false, logs: { [name]: "do not write" } }), /Invalid QA diagnostic/);
    assert.equal(fs.existsSync(workspace.dir), true);
    assert.deepEqual(list(failuresParent), previous);
  }
  const excessive = Object.fromEntries(Array.from({ length: MAX_LOG_FILES + 1 }, (_, index) => [`log-${index}.log`, "test"]));
  assert.throws(() => workspace.finish({ success: false, logs: excessive }), /Invalid QA diagnostic/);
  assert.equal(fs.existsSync(workspace.dir), true);
  assert.throws(() => workspace.finish({}), /outcome must be explicit/);
  workspace.finish({ success: true });
  assert.equal(fs.existsSync(workspace.dir), false);
});

test("diagnostics are byte-bounded, redact credentials and keep oversized object logs valid JSON", (t) => {
  const previous = process.env.ZENMUX_API_KEY;
  process.env.ZENMUX_API_KEY = "workspace-fixture-secret-value";
  t.after(() => { if (previous === undefined) delete process.env.ZENMUX_API_KEY; else process.env.ZENMUX_API_KEY = previous; });
  const workspace = createQaWorkspace("bounded");
  const longError = new Error("large failure ".repeat(15000));
  longError.stack = "stack frame\n".repeat(30000);
  const retained = workspace.finish({ success: false, error: longError, logs: {
    "secret.log": "Bearer example-bearer-token workspace-fixture-secret-value sk-fixture-key-value",
    "text.log": "OLD_HEAD_MUST_DISAPPEAR\n" + "中文日志".repeat(MAX_LOG_BYTES) + "\nTAIL_MARKER",
    "object.json": { entries: Array.from({ length: 4000 }, () => ({ quoted: '"\\\n中文内容'.repeat(4) })) },
  } });
  for (const file of list(retained)) assert.ok(fs.statSync(path.join(retained, file)).size <= MAX_LOG_BYTES, `${file} exceeded byte limit`);
  const secret = fs.readFileSync(path.join(retained, "secret.log"), "utf8");
  for (const value of ["example-bearer-token", "workspace-fixture-secret-value", "sk-fixture-key-value"]) assert.ok(!secret.includes(value));
  const text = fs.readFileSync(path.join(retained, "text.log"), "utf8");
  assert.ok(!text.includes("OLD_HEAD_MUST_DISAPPEAR"));
  assert.ok(text.endsWith("TAIL_MARKER"));
  const object = JSON.parse(fs.readFileSync(path.join(retained, "object.json"), "utf8"));
  assert.equal(object.truncated, true);
  assert.equal(typeof object.tail, "string");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(retained, "failure.json"), "utf8")));
});

test("finish is idempotent and cannot be redirected by mutating its public directory", () => {
  const workspace = createQaWorkspace("immutable");
  const original = workspace.dir;
  assert.throws(() => { workspace.dir = protectedDir; }, TypeError);
  const retained = workspace.finish({ success: false, logs: { "first.log": "first report" } });
  const files = list(retained);
  assert.equal(workspace.finish({ success: true }), retained);
  assert.equal(workspace.finish({ success: false, logs: { "second.log": "must not write" } }), retained);
  assert.deepEqual(list(retained), files);
  assert.equal(fs.existsSync(original), false);
  assertProtected();
});

test("cleanup rejects a replaced workspace inode, including a symlink to an external directory", () => {
  const workspace = createQaWorkspace("identity");
  const moved = `${workspace.dir}-saved`;
  fs.renameSync(workspace.dir, moved);
  try {
    fs.symlinkSync(protectedDir, workspace.dir, "dir");
    assert.throws(() => workspace.finish({ success: true }), /identity changed|unowned/);
    assertProtected();
    fs.unlinkSync(workspace.dir);
    fs.mkdirSync(workspace.dir);
    fs.writeFileSync(path.join(workspace.dir, "replacement.txt"), "replacement must survive");
    assert.throws(() => workspace.finish({ success: true }), /identity changed|unowned/);
    assert.equal(fs.readFileSync(path.join(workspace.dir, "replacement.txt"), "utf8"), "replacement must survive");
  } finally {
    fs.rmSync(workspace.dir, { recursive: true, force: true });
    fs.renameSync(moved, workspace.dir);
    workspace.finish({ success: true });
  }
});

test("source preparation refuses an unowned directory without writing into it", () => {
  const before = list(protectedDir);
  assert.throws(() => prepareQaSource(protectedDir, protectedDir), /unowned/);
  assert.deepEqual(list(protectedDir), before);
  assertProtected();
});

test("source preparation returns only copied Next/node lookup paths and excludes live env/data/build output", () => {
  const project = fs.mkdtempSync(path.join(sandbox, "source-project-"));
  const packageRoot = path.join(project, "node_modules/.pnpm/next-fixture/node_modules/next");
  fs.mkdirSync(path.join(packageRoot, "dist/bin"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules/.pnpm/node_modules"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules/.bin"));
  fs.writeFileSync(path.join(packageRoot, "dist/bin/next"), "fixture next executable");
  fs.writeFileSync(path.join(project, "node_modules/.bin/next"), `do not run source shim ${project}`);
  fs.symlinkSync(".pnpm/next-fixture/node_modules/next", path.join(project, "node_modules/next"), "dir");
  fs.mkdirSync(path.join(project, "src"));
  fs.writeFileSync(path.join(project, "src/index.ts"), "export const fixture = true;");
  fs.writeFileSync(path.join(project, "next.config.ts"), "const nextConfig = {};\nexport default nextConfig;\n");
  fs.writeFileSync(path.join(project, ".env.local"), "ENV_MUST_NOT_BE_COPIED");
  fs.mkdirSync(path.join(project, "data"));
  fs.writeFileSync(path.join(project, "data/readaloud.db"), "DATA_MUST_NOT_BE_COPIED");
  fs.mkdirSync(path.join(project, ".next"));
  fs.writeFileSync(path.join(project, ".next/cache.bin"), "CACHE_MUST_NOT_BE_COPIED");
  const workspace = createQaWorkspace("source-copy");
  try {
    const runtime = prepareQaSource(project, workspace.dir);
    assert.equal(fs.lstatSync(path.join(workspace.dir, "node_modules")).isSymbolicLink(), false);
    assert.equal(runtime.bin, fs.realpathSync(path.join(workspace.dir, "node_modules/next/dist/bin/next")));
    const lookupPaths = runtime.nodePath.split(path.delimiter);
    assert.equal(lookupPaths.length, 3);
    assert.ok([runtime.bin, ...lookupPaths].every((value) => value.startsWith(`${workspace.dir}${path.sep}`)));
    assert.equal(fs.readlinkSync(path.join(workspace.dir, "node_modules/next")), ".pnpm/next-fixture/node_modules/next");
    for (const excluded of [".env.local", "data", ".next"]) assert.equal(fs.existsSync(path.join(workspace.dir, excluded)), false);
    fs.writeFileSync(runtime.bin, "changed isolated executable");
    assert.equal(fs.readFileSync(path.join(packageRoot, "dist/bin/next"), "utf8"), "fixture next executable");
    const config = fs.readFileSync(path.join(workspace.dir, "next.config.ts"), "utf8");
    assert.ok(config.includes(JSON.stringify(workspace.dir)));
    assert.ok(!config.includes("turbopackAdditionalRoots"));
  } finally {
    workspace.finish({ success: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test("fixture setup failure removes the workspace, releases handlers and preserves the original error", async (t) => {
  const expected = new Error("intentional source-copy setup failure");
  const originalWorkspaces = list(workspaceParent);
  const originalFailures = list(failuresParent);
  const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  t.mock.method(fs, "cpSync", () => { throw expected; });
  await assert.rejects(createFixture("setup-failure"), (error) => error === expected);
  assert.deepEqual(list(workspaceParent), originalWorkspaces);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
  const newFailures = list(failuresParent).filter((name) => !originalFailures.includes(name));
  assert.equal(newFailures.length, 1);
  const retained = path.join(failuresParent, newFailures[0]);
  assert.deepEqual(list(retained), ["failure.json", "mock-events.json", "next-test.log"]);
  const metadata = fs.readFileSync(path.join(retained, "failure.json"), "utf8");
  assert.match(metadata, /intentional source-copy setup failure/);
  assert.ok(!list(retained).some((name) => ["src", ".next", "data", "node_modules"].includes(name)));
  assertProtected();
});

test("diagnostic disk errors still remove heavy files and never replace the original setup error", async (t) => {
  const workspace = createQaWorkspace("disk-full");
  populate(workspace);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (path.basename(String(file)) === "failure.json") throw Object.assign(new Error("simulated diagnostic disk full"), { code: "ENOSPC" });
    return write(file, ...args);
  });
  assert.throws(() => workspace.finish({ success: false, error: new Error("primary failure") }), (error) => error.code === "ENOSPC");
  assert.equal(fs.existsSync(workspace.dir), false);
  assertProtected();
  const expected = new Error("original setup error survives logging failure");
  const before = list(workspaceParent);
  t.mock.method(fs, "cpSync", () => { throw expected; });
  await assert.rejects(createFixture("setup-disk-full"), (error) => error === expected);
  assert.deepEqual(list(workspaceParent), before);
  assertProtected();
});

test("circular diagnostic objects cannot leave source, dependencies or SQLite behind", () => {
  const workspace = createQaWorkspace("circular-log");
  populate(workspace);
  const circular = {};
  circular.self = circular;
  assert.throws(() => workspace.finish({ success: false, logs: { "circular.json": circular } }), /circular/i);
  assert.equal(fs.existsSync(workspace.dir), false);
  assertProtected();
});

test("a transient EPERM process probe is treated as alive until ESRCH, without signaling any real PID", { skip: process.platform === "win32" }, async (t) => {
  const signals = [];
  let probes = 0;
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, -1234567);
    if (signal === 0) {
      probes++;
      throw Object.assign(new Error("simulated process probe"), { code: probes === 1 ? "EPERM" : "ESRCH" });
    }
    signals.push(signal);
    return true;
  });
  await stopQaProcess({ pid: 1234567, exitCode: null, signalCode: null });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.ok(probes >= 2);
});
