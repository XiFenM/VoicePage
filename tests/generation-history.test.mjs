import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/generation/retry-policy") return nextResolve(new URL("../src/lib/generation/retry-policy.ts", import.meta.url).href, context);
  return nextResolve(specifier, context);
} });
const { automaticRetryLabel, generationEventLabel, mergeGenerationEvents, retryCountdown } = await import("../src/components/generation-history.ts");

const event = (id, patch = {}) => ({ id, idx: 0, phase: "tts", attempt: 1, type: "failed", createdAt: id * 1_000, ...patch });

test("自动退避展示下一次时间，时间到后显示等待调度而非负数或完成", () => {
  assert.equal(retryCountdown(6_000, 1_000), "5 秒后自动重试");
  assert.equal(retryCountdown(301_000, 1_000), "约 5 分钟后自动重试");
  assert.equal(retryCountdown(6_000, 6_000), "等待后台开始重试");
  assert.equal(retryCountdown(6_000, 20_000), "等待后台开始重试");
  assert.equal(automaticRetryLabel({ status: "queued", phase: "queued", autoRetryCount: 1, nextRetryAt: 6_000 }, 1_000), "自动重试 1/2 · 5 秒后自动重试");
});

test("重试执行中显示次数和当前阶段，成功后持久旧错误不再显示为进行中重试", () => {
  const retry = { status: "running", phase: "tts", autoRetryCount: 2, lastError: { message: "previous failure" } };
  assert.equal(automaticRetryLabel(retry, 20_000), "自动重试 2/2 · 正在语音合成");
  assert.equal(automaticRetryLabel({ ...retry, status: "completed" }, 20_000), null);
  assert.equal(automaticRetryLabel({ ...retry, status: "cancelled" }, 20_000), null);
  assert.equal(automaticRetryLabel({ ...retry, autoRetryCount: 0 }, 20_000), null);
});

test("刷新最新日志与已加载旧页去重合并，保留原来的更早游标", () => {
  const current = { loaded: true, events: [event(8), event(7), event(3), event(2)], nextCursor: 2 };
  const next = mergeGenerationEvents(current, { events: [event(10), event(9), event(8)], nextCursor: 8 }, "latest");
  assert.deepEqual(next.events.map((item) => item.id), [10, 9, 8, 7, 3, 2]);
  assert.equal(next.nextCursor, 2);
  assert.deepEqual(current.events.map((item) => item.id), [8, 7, 3, 2]);
});

test("新增超过一页日志时，后续分页先补新旧页之间的缺口", () => {
  const current = { loaded: true, events: [event(4), event(3), event(2)], nextCursor: 2 };
  const latest = mergeGenerationEvents(current, { events: [event(10), event(9), event(8)], nextCursor: 8 }, "latest");
  assert.equal(latest.nextCursor, 8);
  assert.ok(latest.events.some((item) => item.id === 2));
  const filled = mergeGenerationEvents(latest, { events: [event(7), event(6), event(5), event(4)], nextCursor: 4 }, "older");
  assert.deepEqual(filled.events.map((item) => item.id), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(filled.nextCursor, 4);
  const complete = mergeGenerationEvents(filled, { events: [event(3), event(2), event(1)] }, "older");
  assert.deepEqual(complete.events.map((item) => item.id), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  assert.equal(complete.nextCursor, undefined);
});

test("已读完整日志后有新事件，刷新不会错误恢复已耗尽的分页游标", () => {
  const complete = { loaded: true, events: [event(3), event(2), event(1)] };
  const next = mergeGenerationEvents(complete, { events: [event(4), event(3)], nextCursor: 3 }, "latest");
  assert.deepEqual(next.events.map((item) => item.id), [4, 3, 2, 1]);
  assert.equal(next.nextCursor, undefined);
});

test("初次空日志和分页响应不会覆盖已经加载的较新事件", () => {
  const empty = mergeGenerationEvents({ loaded: false, events: [] }, { events: [] }, "latest");
  assert.equal(empty.loaded, true);
  assert.equal(empty.events.length, 0);
  const current = { loaded: true, events: [event(9), event(8)], nextCursor: 8 };
  const next = mergeGenerationEvents(current, { events: [event(7), event(6)], nextCursor: 6 }, "older");
  assert.deepEqual(next.events.map((item) => item.id), [9, 8, 7, 6]);
});

test("最新页已包含服务端全部日志时，删除导入覆盖前的旧事件", () => {
  const previous = { loaded: true, events: [event(100), event(90), event(80)], nextCursor: 80 };
  const afterImport = mergeGenerationEvents(previous, { events: [event(120), event(119)] }, "latest");
  assert.deepEqual(afterImport.events.map((item) => item.id), [120, 119]);
  assert.equal(afterImport.nextCursor, undefined);
  const empty = mergeGenerationEvents(afterImport, { events: [] }, "latest");
  assert.equal(empty.events.length, 0);
});

test("事件文案区分自动尝试、用户手动重试和服务恢复", () => {
  assert.equal(generationEventLabel(event(1, { type: "retry_scheduled", retrySource: "automatic", retryNumber: 2 })), "已安排自动重试 2/2");
  assert.equal(generationEventLabel(event(2, { type: "retry_started", retrySource: "manual" })), "开始手动重试");
  assert.equal(generationEventLabel(event(3, { type: "resumed", retrySource: "recovery" })), "服务恢复后继续执行");
});
