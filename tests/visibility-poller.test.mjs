import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIVE_POLL_MS, IDLE_POLL_MS, createVisibilityPoller } from "../src/components/visibility-poller.ts";

class Visibility extends EventTarget {
  hidden;
  listeners = new Set();
  constructor(hidden = false) { super(); this.hidden = hidden; }
  addEventListener(type, callback, options) {
    if (type === "visibilitychange") this.listeners.add(callback);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    if (type === "visibilitychange") this.listeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  show(hidden) {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(t, { hidden = false, interval = ACTIVE_POLL_MS, visibility: source, shouldPollWhenHidden, reuseClock = false } = {}) {
  if (!reuseClock) t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = source ?? new Visibility(hidden);
  const calls = [];
  const errors = [];
  let currentInterval = interval;
  const controller = createVisibilityPoller({
    visibility,
    shouldPollWhenHidden,
    getInterval: () => currentInterval,
    onError: (error) => errors.push(error),
    poll: (signal) => new Promise((resolve, reject) => {
      const call = { signal, settled: false };
      call.resolve = () => { call.settled = true; resolve(); };
      call.reject = (error) => { call.settled = true; reject(error); };
      calls.push(call);
      assert.ok(calls.filter((item) => !item.signal.aborted && !item.settled).length <= 1, "Only one non-aborted read may be active");
    }),
  });
  t.after(() => controller.dispose());
  return {
    visibility, calls, errors, controller,
    setInterval: (value) => { currentInterval = value; },
    advance: async (ms) => { t.mock.timers.tick(ms); await flush(); },
    finish: async (index) => { calls[index].resolve(); await flush(); },
    reject: async (index, error) => { calls[index].reject(error); await flush(); },
  };
}

test("a hidden page starts no reads, and becoming visible performs an immediate read", async (t) => {
  const f = setup(t, { hidden: true });
  assert.equal(f.calls.length, 0);
  f.controller.refresh();
  f.controller.reschedule();
  await f.advance(90000);
  assert.equal(f.calls.length, 0);
  f.visibility.show(false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.visibility.listeners.size, 1);
});

test("visible active reads use two seconds after completion and never overlap a slow read", async (t) => {
  const f = setup(t);
  assert.equal(f.calls.length, 1);
  await f.advance(30000);
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  await f.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  assert.equal(ACTIVE_POLL_MS, 2000);
});

test("idle reads use thirty seconds and reschedule restarts the interval from now", async (t) => {
  const f = setup(t);
  await f.finish(0);
  await f.advance(500);
  f.setInterval(IDLE_POLL_MS);
  f.controller.reschedule();
  await f.advance(29999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  await f.advance(1000);
  f.setInterval(ACTIVE_POLL_MS);
  f.controller.reschedule();
  await f.advance(1999);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls.length, 3);
  assert.equal(IDLE_POLL_MS, 30000);
});

test("rescheduling during a read neither overlaps nor adds a refresh; completion uses the latest interval", async (t) => {
  const f = setup(t);
  f.setInterval(IDLE_POLL_MS);
  f.controller.reschedule();
  f.controller.reschedule();
  await f.advance(60000);
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  assert.equal(f.calls.length, 1);
  await f.advance(29999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
});

test("hiding clears the scheduled read, and hidden manual refresh waits until visibility resumes", async (t) => {
  const f = setup(t);
  await f.finish(0);
  await f.advance(1500);
  f.visibility.show(true);
  f.controller.refresh();
  f.controller.refresh();
  f.controller.reschedule();
  await f.advance(90000);
  assert.equal(f.calls.length, 1);
  f.visibility.show(false);
  assert.equal(f.calls.length, 2);
});

test("hide aborts a hanging read; show starts a replacement and repeated visibility events do not duplicate it", async (t) => {
  const f = setup(t);
  f.visibility.show(true);
  assert.equal(f.calls[0].signal.aborted, true);
  await f.advance(60000);
  assert.equal(f.calls.length, 1);
  f.visibility.show(false);
  f.visibility.show(false);
  f.visibility.show(false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].signal.aborted, false);
  await f.finish(0); // The retired request ignored abort and resolved late.
  await f.advance(60000);
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  assert.equal(f.calls.length, 2, "Duplicate visible events must not queue a follow-up");
  await f.advance(2000);
  assert.equal(f.calls.length, 3);
});

test("a late aborted rejection cannot report an error or postpone the replacement's scheduled timer", async (t) => {
  const f = setup(t);
  f.visibility.show(true);
  f.visibility.show(false);
  await f.finish(1);
  await f.advance(1500);
  await f.reject(0, new Error("late request failure"));
  assert.deepEqual(f.errors, []);
  await f.advance(500);
  assert.equal(f.calls.length, 3, "Old finally must not replace the newer timer");
});

test("multiple manual refreshes during one read coalesce into exactly one immediate follow-up", async (t) => {
  const f = setup(t);
  f.controller.refresh();
  f.controller.refresh();
  f.controller.refresh();
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  assert.equal(f.calls.length, 2);
  await f.advance(1999);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls.length, 3);
});

test("an idle manual refresh replaces its pending timer rather than leaving a duplicate", async (t) => {
  const f = setup(t);
  await f.finish(0);
  await f.advance(1000);
  f.controller.refresh();
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  await f.advance(1000);
  assert.equal(f.calls.length, 2, "The old timer must have been cleared");
  await f.advance(1000);
  assert.equal(f.calls.length, 3);
});

test("visible read failures are reported once and resume the normal interval", async (t) => {
  const f = setup(t);
  const error = new Error("temporary GET failure");
  await f.reject(0, error);
  assert.deepEqual(f.errors, [error]);
  await f.advance(1999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.equal(f.calls.length, 2);
  f.visibility.show(true);
  await f.reject(1, new DOMException("visibility pause", "AbortError"));
  assert.deepEqual(f.errors, [error]);
});

test("dispose removes visibility listeners, aborts its read and ignores late outcomes and future actions", async (t) => {
  const f = setup(t);
  f.controller.refresh();
  f.controller.dispose();
  f.controller.dispose();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.visibility.listeners.size, 0);
  f.visibility.show(true);
  f.visibility.show(false);
  f.controller.refresh();
  f.controller.reschedule();
  await f.reject(0, new Error("late after unmount"));
  await f.advance(90000);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.errors, []);
});

test("disposing after a completed read clears the remaining timer", async (t) => {
  const f = setup(t);
  await f.finish(0);
  f.controller.dispose();
  await f.advance(90000);
  assert.equal(f.calls.length, 1);
});

test("hidden playback exception resumes immediately, polls unfinished work, and aborts when playback stops or generation completes", async (t) => {
  let eligible = false;
  const f = setup(t, { hidden: true, shouldPollWhenHidden: () => eligible });
  assert.equal(f.calls.length, 0);
  eligible = true;
  f.controller.reschedule();
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  await f.advance(2000);
  assert.equal(f.calls.length, 2);
  eligible = false;
  f.controller.reschedule();
  assert.equal(f.calls[1].signal.aborted, true);
  await f.advance(90000);
  assert.equal(f.calls.length, 2);
  eligible = true;
  f.controller.reschedule();
  assert.equal(f.calls.length, 3);
  await f.finish(1); // A retired request cannot interfere with resumed listening.
  await f.finish(2);
  await f.advance(2000);
  assert.equal(f.calls.length, 4);
  eligible = false;
  f.controller.reschedule();
  assert.equal(f.calls[3].signal.aborted, true);
  await f.advance(90000);
  assert.equal(f.calls.length, 4);
  f.visibility.show(false);
  assert.equal(f.calls.length, 5, "A visible page refreshes even after playback stopped");
});

test("returning from hidden playback refreshes immediately and replaces the hidden polling timer", async (t) => {
  const f = setup(t, { shouldPollWhenHidden: () => true });
  await f.finish(0);
  f.visibility.show(true);
  await f.advance(2000);
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  await f.advance(500);
  f.visibility.show(false);
  assert.equal(f.calls.length, 3);
  f.visibility.show(false);
  await f.finish(2);
  await f.advance(1500);
  assert.equal(f.calls.length, 3, "The old hidden timer must not also fire");
  await f.advance(500);
  assert.equal(f.calls.length, 4);
});

test("hidden playback keeps an existing read; returning while it runs coalesces one immediate follow-up", async (t) => {
  const f = setup(t, { shouldPollWhenHidden: () => true });
  f.visibility.show(true);
  assert.equal(f.calls[0].signal.aborted, false);
  f.visibility.show(false);
  f.visibility.show(false);
  assert.equal(f.calls.length, 1);
  await f.finish(0);
  assert.equal(f.calls.length, 2);
  await f.finish(1);
  await f.advance(1999);
  assert.equal(f.calls.length, 2);
  await f.advance(1);
  assert.equal(f.calls.length, 3);
});

test("a Reader playback exception does not keep the independent library/history poller active", async (t) => {
  let playingUnfinished = true;
  const reader = setup(t, { shouldPollWhenHidden: () => playingUnfinished });
  const library = setup(t, { visibility: reader.visibility, reuseClock: true });
  reader.visibility.show(true);
  assert.equal(reader.calls[0].signal.aborted, false);
  assert.equal(library.calls[0].signal.aborted, true);
  library.controller.refresh();
  library.controller.reschedule();
  await reader.finish(0);
  await reader.advance(2000);
  assert.equal(reader.calls.length, 2);
  assert.equal(library.calls.length, 1);
  playingUnfinished = false;
  reader.controller.reschedule();
  assert.equal(reader.calls[1].signal.aborted, true);
  await reader.advance(30000);
  assert.equal(reader.calls.length, 2);
  assert.equal(library.calls.length, 1);
  reader.visibility.show(false);
  assert.equal(reader.calls.length, 3);
  assert.equal(library.calls.length, 2);
});
