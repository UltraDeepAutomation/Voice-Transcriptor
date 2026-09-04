import { describe, expect, it } from "vitest";
import { mayAutosaveUiPreferences } from "../src/settings-autosave";

describe("mayAutosaveUiPreferences", () => {
  it("refuses to write preferences that were never read", () => {
    // The state a renderer is in when the backend was still starting up:
    // the load failed, its `finally` cleared the re-entrancy guard, and
    // the DOM holds markup defaults rather than the user's choices.
    expect(mayAutosaveUiPreferences({ loaded: false, suppressed: false })).toBe(false);
  });

  it("allows writing once a load has succeeded", () => {
    expect(mayAutosaveUiPreferences({ loaded: true, suppressed: false })).toBe(true);
  });

  it("refuses while a load is populating the DOM", () => {
    expect(mayAutosaveUiPreferences({ loaded: true, suppressed: true })).toBe(false);
  });

  it("refuses when both reasons apply", () => {
    expect(mayAutosaveUiPreferences({ loaded: false, suppressed: true })).toBe(false);
  });
});
