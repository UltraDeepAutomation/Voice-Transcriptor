import { describe, it, expect, vi } from "vitest";

import { createGatedPoll, type PollTimers } from "../src/gated-poll";

/** Deterministic stand-in for setTimeout/clearTimeout. */
function fakeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  const timers: PollTimers = {
    setTimeout(handler) {
      const handle = nextHandle++;
      pending.set(handle, handler);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
  };
  return {
    timers,
    get scheduled() {
      return pending.size;
    },
    /** Fire every currently-pending wakeup. */
    async fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, handler] of due) handler();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("createGatedPoll", () => {
  it("does not schedule anything while the gate is closed", () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => false,
      tick,
      timers: clock.timers,
    });

    poll.sync();

    // The whole point: a closed gate costs zero wakeups, not a wakeup
    // that returns early.
    expect(clock.scheduled).toBe(0);
    expect(poll.active).toBe(false);
    expect(tick).not.toHaveBeenCalled();
  });

  it("arms once the gate opens and keeps the cadence", async () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    let open = false;
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => open,
      tick,
      timers: clock.timers,
    });

    poll.sync();
    expect(clock.scheduled).toBe(0);

    open = true;
    poll.sync();
    expect(clock.scheduled).toBe(1);

    await clock.fire();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(clock.scheduled).toBe(1);

    await clock.fire();
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("suspends immediately when the gate closes", () => {
    const clock = fakeTimers();
    let open = true;
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => open,
      tick: vi.fn(),
      timers: clock.timers,
    });

    poll.sync();
    expect(clock.scheduled).toBe(1);

    open = false;
    poll.sync();

    expect(clock.scheduled).toBe(0);
    expect(poll.active).toBe(false);
  });

  it("skips a tick whose gate closed while the wakeup was pending", async () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    let open = true;
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => open,
      tick,
      timers: clock.timers,
    });

    poll.sync();
    open = false;
    await clock.fire();

    expect(tick).not.toHaveBeenCalled();
    expect(clock.scheduled).toBe(0);
  });

  it("is idempotent: repeated sync calls never stack wakeups", () => {
    const clock = fakeTimers();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick: vi.fn(),
      timers: clock.timers,
    });

    poll.sync();
    poll.sync();
    poll.sync();

    expect(clock.scheduled).toBe(1);
  });

  it("does not overlap ticks when one outlives the interval", async () => {
    const clock = fakeTimers();
    let release: () => void = () => {};
    const tick = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.sync();
    await clock.fire();
    expect(tick).toHaveBeenCalledTimes(1);

    // While the first tick is still in flight nothing else is queued —
    // with setInterval these would pile up behind the slow request.
    expect(clock.scheduled).toBe(0);
    poll.sync();
    expect(clock.scheduled).toBe(0);
    expect(poll.active).toBe(true);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(clock.scheduled).toBe(1);
  });

  it("keeps polling after a tick throws, and reports it", async () => {
    const clock = fakeTimers();
    const onError = vi.fn();
    const tick = vi.fn(() => { throw new Error("boom"); });
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick,
      name: "network",
      timers: clock.timers,
      onError,
    });

    poll.sync();
    await clock.fire();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe("network");
    // A transient failure must not silently kill the poll forever.
    expect(clock.scheduled).toBe(1);
  });

  it("keeps polling after a tick rejects", async () => {
    const clock = fakeTimers();
    const onError = vi.fn();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick: () => Promise.reject(new Error("offline")),
      timers: clock.timers,
      onError,
    });

    poll.sync();
    await clock.fire();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(clock.scheduled).toBe(1);
  });

  it("refreshNow ticks immediately and restarts the cadence from there", async () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.sync();
    expect(tick).not.toHaveBeenCalled();

    poll.refreshNow();
    await Promise.resolve();
    await Promise.resolve();

    expect(tick).toHaveBeenCalledTimes(1);
    // Exactly one pending wakeup: the pre-existing one was cancelled,
    // not left to double the rate.
    expect(clock.scheduled).toBe(1);
  });

  it("refreshNow is a no-op while the gate is closed", async () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => false,
      tick,
      timers: clock.timers,
    });

    poll.refreshNow();
    await Promise.resolve();

    expect(tick).not.toHaveBeenCalled();
    expect(clock.scheduled).toBe(0);
  });

  it("stop is permanent and idempotent", async () => {
    const clock = fakeTimers();
    const tick = vi.fn();
    const poll = createGatedPoll({
      intervalMs: 2000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.sync();
    poll.stop();
    poll.stop();
    expect(clock.scheduled).toBe(0);

    poll.sync();
    poll.refreshNow();
    await Promise.resolve();

    expect(clock.scheduled).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });
});

describe("refreshNow while a tick is in flight (U-005)", () => {
  it("runs the queued refresh once the in-flight tick finishes", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const poll = createGatedPoll({
      intervalMs: 10_000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.refreshNow();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);

    // The network went offline while the first tick was still reading
    // the old state. Before the fix this call was silently dropped.
    poll.refreshNow();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(poll.active).toBe(true);

    release!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("coalesces several mid-tick refreshes into one catch-up run", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const poll = createGatedPoll({
      intervalMs: 10_000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.refreshNow();
    await Promise.resolve();
    poll.refreshNow();
    poll.refreshNow();
    poll.refreshNow();

    release!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(2);
    poll.stop();
  });

  it("drops the queued refresh when the gate closed while the tick ran", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    let open = true;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const poll = createGatedPoll({
      intervalMs: 10_000,
      shouldRun: () => open,
      tick,
      timers: clock.timers,
    });

    poll.refreshNow();
    await Promise.resolve();
    poll.refreshNow();
    open = false;

    release!();
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(clock.scheduled).toBe(0);
    poll.stop();
  });

  it("does not run a queued refresh after stop()", async () => {
    const clock = fakeTimers();
    let release: (() => void) | null = null;
    const tick = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const poll = createGatedPoll({
      intervalMs: 10_000,
      shouldRun: () => true,
      tick,
      timers: clock.timers,
    });

    poll.refreshNow();
    await Promise.resolve();
    poll.refreshNow();
    poll.stop();

    release!();
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
