import { describe, it, expect } from "vitest";

import {
  RECORDINGS_WINDOW_CHUNK,
  RECORDINGS_WINDOW_MINIMUM,
  grownWindowSize,
  resolveWindowSize,
  shouldGrowWindow,
  shouldResetWindowAfterLoad,
  windowStatusText,
} from "../src/list-window";

const base = { total: 5900, current: 0, minimum: RECORDINGS_WINDOW_MINIMUM, selectedIndex: -1 };

describe("resolveWindowSize", () => {
  it("materialises the minimum on a fresh list", () => {
    expect(resolveWindowSize(base)).toBe(RECORDINGS_WINDOW_MINIMUM);
  });

  it("never exceeds the number of items available", () => {
    expect(resolveWindowSize({ ...base, total: 12 })).toBe(12);
  });

  it("is zero for an empty set", () => {
    expect(resolveWindowSize({ ...base, total: 0 })).toBe(0);
  });

  it("never shrinks a window that already grew", () => {
    // Scrolling back up must not destroy rows the user scrolled past.
    expect(resolveWindowSize({ ...base, current: 1400 })).toBe(1400);
  });

  it("always extends far enough to include the selected row", () => {
    // A selection outside the window would break keyboard navigation
    // and scrollIntoView — the row simply would not exist.
    expect(resolveWindowSize({ ...base, selectedIndex: 4321 })).toBe(4322);
  });

  it("does not extend for a selection already inside the window", () => {
    expect(resolveWindowSize({ ...base, selectedIndex: 5 })).toBe(RECORDINGS_WINDOW_MINIMUM);
  });

  it("clamps a selection-driven extension to the total", () => {
    expect(resolveWindowSize({ ...base, total: 10, selectedIndex: 9 })).toBe(10);
  });
});

describe("shouldGrowWindow", () => {
  it("grows once the viewport nears the end", () => {
    expect(shouldGrowWindow({ scrollTop: 9000, clientHeight: 800, scrollHeight: 10000 })).toBe(true);
  });

  it("does not grow while the user is far from the end", () => {
    expect(shouldGrowWindow({ scrollTop: 0, clientHeight: 800, scrollHeight: 10000 })).toBe(false);
  });

  it("does not grow when the content fits the viewport", () => {
    // Otherwise a short list reads as "at the bottom" forever and grows
    // the window on every scroll event for nothing.
    expect(shouldGrowWindow({ scrollTop: 0, clientHeight: 800, scrollHeight: 600 })).toBe(false);
  });

  it("honours an explicit threshold", () => {
    const metrics = { scrollTop: 8000, clientHeight: 800, scrollHeight: 10000 };
    expect(shouldGrowWindow(metrics, 100)).toBe(false);
    expect(shouldGrowWindow(metrics, 1500)).toBe(true);
  });

  it("rejects non-finite metrics rather than growing blindly", () => {
    expect(shouldGrowWindow({ scrollTop: NaN, clientHeight: 800, scrollHeight: 10000 })).toBe(false);
  });
});

describe("grownWindowSize", () => {
  it("adds one chunk", () => {
    expect(grownWindowSize(200, 5900)).toBe(200 + RECORDINGS_WINDOW_CHUNK);
  });

  it("stops at the total", () => {
    expect(grownWindowSize(5800, 5900)).toBe(5900);
    expect(grownWindowSize(5900, 5900)).toBe(5900);
  });
});

describe("windowStatusText", () => {
  it("reports coverage while the list is truncated", () => {
    expect(windowStatusText(200, 5900)).toBe("Showing 200 of 5900");
  });

  it("says nothing once everything is rendered", () => {
    // A count on a complete list is noise, not information.
    expect(windowStatusText(5900, 5900)).toBe("");
    expect(windowStatusText(0, 0)).toBe("");
  });
});

describe("shouldResetWindowAfterLoad", () => {
  it("keeps the window on a background refresh that only prepends a new recording", () => {
    // The exact path that threw the user back to the top: save a
    // recording, the deferred refresh reloads the archive, and every row
    // that was on screen is still there.
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: false,
        previousWindowKeys: ["a", "b", "c"],
        nextKeys: ["new", "a", "b", "c"],
      }),
    ).toBe(false);
  });

  it("keeps the window when some visible rows were deleted but others remain", () => {
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: false,
        previousWindowKeys: ["a", "b", "c"],
        nextKeys: ["c"],
      }),
    ).toBe(false);
  });

  it("resets when the archive directory changed", () => {
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: true,
        previousWindowKeys: ["a"],
        nextKeys: ["a"],
      }),
    ).toBe(true);
  });

  it("resets when nothing that was on screen survives", () => {
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: false,
        previousWindowKeys: ["a", "b"],
        nextKeys: ["x", "y"],
      }),
    ).toBe(true);
  });

  it("resets on the first load, when nothing was on screen", () => {
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: false,
        previousWindowKeys: [],
        nextKeys: ["a", "b"],
      }),
    ).toBe(true);
  });

  it("resets when the archive became empty", () => {
    expect(
      shouldResetWindowAfterLoad({
        directoryChanged: false,
        previousWindowKeys: ["a"],
        nextKeys: [],
      }),
    ).toBe(true);
  });
});
