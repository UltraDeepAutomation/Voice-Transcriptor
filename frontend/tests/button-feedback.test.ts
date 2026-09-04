import { beforeEach, describe, expect, it } from "vitest";

import { flashButtonFeedback } from "../src/button-feedback";

/**
 * The flash mechanism, with its timers injected so the restore can be
 * fired on demand. Both failures the previous implementation had are
 * pinned here: it read the labels to restore out of the live element
 * (where a previous flash had already written "Copied"), and it never
 * kept the timer handle, so the first restore still fired after the
 * second flash had begun.
 */
interface FakeClock {
  set: (fn: () => void, ms: number) => number;
  clear: (handle: number) => void;
  /** Run every timer that has not been cleared, oldest first. */
  runAll: () => void;
  pending: () => number;
}

function fakeClock(): FakeClock {
  const timers = new Map<number, () => void>();
  let next = 1;
  return {
    set(fn) {
      const handle = next++;
      timers.set(handle, fn);
      return handle;
    },
    clear(handle) {
      timers.delete(handle);
    },
    runAll() {
      const due = Array.from(timers.entries());
      timers.clear();
      for (const [, fn] of due) fn();
    },
    pending: () => timers.size,
  };
}

let clock: FakeClock;
let btn: HTMLButtonElement;

function flash(label: string, opts: { swapLabel?: boolean } = {}): void {
  flashButtonFeedback(btn, label, "Copy transcript", {
    durationMs: 900,
    setTimer: clock.set,
    clearTimer: clock.clear,
    ...opts,
  });
}

beforeEach(() => {
  clock = fakeClock();
  btn = document.createElement("button");
  btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy transcript");
  btn.title = "Copy transcript";
});

describe("flashButtonFeedback", () => {
  it("announces the outcome and marks it visually", () => {
    flash("Copied");
    expect(btn.getAttribute("aria-label")).toBe("Copied");
    expect(btn.title).toBe("Copied");
    expect(btn.classList.contains("is-copy-ok")).toBe(true);
  });

  it("distinguishes a failure from a success", () => {
    flash("Copy failed");
    expect(btn.classList.contains("is-copy-failed")).toBe(true);
    expect(btn.classList.contains("is-copy-ok")).toBe(false);
  });

  it("restores the resting labels when the flash ends", () => {
    flash("Copied");
    clock.runAll();
    expect(btn.getAttribute("aria-label")).toBe("Copy transcript");
    expect(btn.title).toBe("Copy transcript");
    expect(btn.classList.contains("is-copy-ok")).toBe(false);
  });

  it("swaps the visible label only when asked, and puts it back", () => {
    flash("Copied");
    expect(btn.textContent).toBe("Copy");
    clock.runAll();

    flash("Copied", { swapLabel: true });
    expect(btn.textContent).toBe("Copied");
    clock.runAll();
    expect(btn.textContent).toBe("Copy");
  });

  it("restores the ORIGINAL labels after a second click inside the window", () => {
    flash("Copied", { swapLabel: true });
    // The user clicks again while "Copied" is still on the button.
    flash("Copy failed", { swapLabel: true });
    clock.runAll();
    expect(btn.textContent).toBe("Copy");
    expect(btn.getAttribute("aria-label")).toBe("Copy transcript");
    expect(btn.title).toBe("Copy transcript");
  });

  it("cancels the previous restore instead of leaving two in flight", () => {
    flash("Copied");
    expect(clock.pending()).toBe(1);
    flash("Copied");
    expect(clock.pending()).toBe(1);
  });

  it("falls back to the resting label when the element carries none", () => {
    const bare = document.createElement("button");
    flashButtonFeedback(bare, "Copied", "Copy result text", {
      durationMs: 900,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });
    clock.runAll();
    expect(bare.getAttribute("aria-label")).toBe("Copy result text");
    expect(bare.title).toBe("Copy result text");
  });

  it("keeps each button's own resting state", () => {
    const other = document.createElement("button");
    other.textContent = "Copy";
    other.setAttribute("aria-label", "Copy result text");
    flash("Copied", { swapLabel: true });
    flashButtonFeedback(other, "Copied", "Copy result text", {
      durationMs: 900,
      setTimer: clock.set,
      clearTimer: clock.clear,
    });
    clock.runAll();
    expect(btn.getAttribute("aria-label")).toBe("Copy transcript");
    expect(other.getAttribute("aria-label")).toBe("Copy result text");
  });
});
