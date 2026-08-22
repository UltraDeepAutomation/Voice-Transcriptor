import { describe, it, expect, beforeEach } from "vitest";

import { reconcileRecordingsList, type RecordingRow, type RowBuildApi } from "../src/recordings-list-reconciler";

interface TestItem extends RecordingRow {
  key: string;
  title: string;
  meta: string;
}

function createList(): HTMLElement {
  const list = document.createElement("ul");
  list.id = "recordingsList";
  return list;
}

function createApi(): RowBuildApi<TestItem> & { createCount: number; updateCount: number } {
  const api = {
    createCount: 0,
    updateCount: 0,
    create(item: TestItem): HTMLElement {
      api.createCount++;
      const li = document.createElement("li");
      li.className = "recording-item";
      li.dataset.recordingKey = item.key;
      const title = document.createElement("span");
      title.className = "rec-title";
      title.textContent = item.title;
      const meta = document.createElement("span");
      meta.className = "rec-meta";
      meta.textContent = item.meta;
      li.appendChild(title);
      li.appendChild(meta);
      return li;
    },
    update(row: HTMLElement, item: TestItem): void {
      api.updateCount++;
      const title = row.querySelector<HTMLElement>(".rec-title");
      const meta = row.querySelector<HTMLElement>(".rec-meta");
      if (title) title.textContent = item.title;
      if (meta) meta.textContent = item.meta;
    },
  };
  return api;
}

function getKeys(list: HTMLElement): string[] {
  return Array.from(list.children)
    .filter((n): n is HTMLElement => n instanceof HTMLElement)
    .map((n) => n.dataset.recordingKey || "");
}

describe("reconcileRecordingsList", () => {
  let list: HTMLElement;

  beforeEach(() => {
    list = createList();
    document.body.appendChild(list);
  });

  it("renders all items in order on empty list", () => {
    const api = createApi();
    const items: TestItem[] = [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "c", title: "Gamma", meta: "3s" },
    ];
    const { stats } = reconcileRecordingsList(list, items, api);
    expect(getKeys(list)).toEqual(["a", "b", "c"]);
    expect(stats.created).toBe(3);
    expect(stats.reused).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.moved).toBe(0);
  });

  it("reuses DOM nodes when keys overlap (preserves scroll position)", () => {
    const api = createApi();
    const initial: TestItem[] = [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "c", title: "Gamma", meta: "3s" },
    ];
    const { list: l1 } = reconcileRecordingsList(list, initial, api);
    const originalNodes = Array.from(l1.children) as HTMLElement[];
    const aNode = l1.querySelector<HTMLElement>('[data-recording-key="a"]')!;

    const refreshed: TestItem[] = [
      { key: "a", title: "Alpha updated", meta: "1.5s" },
      { key: "b", title: "Beta updated", meta: "2.5s" },
      { key: "c", title: "Gamma updated", meta: "3.5s" },
    ];
    api.createCount = 0;
    api.updateCount = 0;
    const { stats } = reconcileRecordingsList(l1, refreshed, api);
    expect(getKeys(l1)).toEqual(["a", "b", "c"]);
    expect(stats.reused).toBe(3);
    expect(stats.created).toBe(0);
    expect(stats.removed).toBe(0);
    expect(stats.moved).toBe(0);
    expect(api.createCount).toBe(0);
    expect(api.updateCount).toBe(3);
    const newANode = l1.querySelector<HTMLElement>('[data-recording-key="a"]')!;
    expect(newANode).toBe(aNode);
    expect(Array.from(l1.children)).toEqual(originalNodes);
    expect(aNode.querySelector(".rec-title")!.textContent).toBe("Alpha updated");
    expect(aNode.querySelector(".rec-meta")!.textContent).toBe("1.5s");
  });

  it("appends new items without reordering existing ones", () => {
    const api = createApi();
    const initial: TestItem[] = [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
    ];
    reconcileRecordingsList(list, initial, api);
    const aNode = list.querySelector<HTMLElement>('[data-recording-key="a"]')!;
    const bNode = list.querySelector<HTMLElement>('[data-recording-key="b"]')!;

    api.createCount = 0;
    api.updateCount = 0;
    const extended: TestItem[] = [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "c", title: "Gamma", meta: "3s" },
    ];
    const { stats } = reconcileRecordingsList(list, extended, api);
    expect(getKeys(list)).toEqual(["a", "b", "c"]);
    expect(stats.reused).toBe(2);
    expect(stats.created).toBe(1);
    expect(stats.removed).toBe(0);
    expect(list.querySelector<HTMLElement>('[data-recording-key="a"]')).toBe(aNode);
    expect(list.querySelector<HTMLElement>('[data-recording-key="b"]')).toBe(bNode);
  });

  it("removes rows whose keys disappear (filtered/deleted)", () => {
    const api = createApi();
    reconcileRecordingsList(list, [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "c", title: "Gamma", meta: "3s" },
    ], api);

    api.createCount = 0;
    api.updateCount = 0;
    const { stats } = reconcileRecordingsList(list, [
      { key: "b", title: "Beta", meta: "2s" },
    ], api);
    expect(getKeys(list)).toEqual(["b"]);
    expect(stats.removed).toBe(2);
    expect(stats.reused).toBe(1);
    expect(stats.created).toBe(0);
  });

  it("reorders by moving existing nodes to new positions without recreating", () => {
    const api = createApi();
    reconcileRecordingsList(list, [
      { key: "a", title: "Alpha", meta: "1s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "c", title: "Gamma", meta: "3s" },
    ], api);
    const aNode = list.querySelector<HTMLElement>('[data-recording-key="a"]')!;
    const cNode = list.querySelector<HTMLElement>('[data-recording-key="c"]')!;

    api.createCount = 0;
    api.updateCount = 0;
    const reordered: TestItem[] = [
      { key: "c", title: "Gamma", meta: "3s" },
      { key: "b", title: "Beta", meta: "2s" },
      { key: "a", title: "Alpha", meta: "1s" },
    ];
    const { stats } = reconcileRecordingsList(list, reordered, api);
    expect(getKeys(list)).toEqual(["c", "b", "a"]);
    expect(list.querySelector<HTMLElement>('[data-recording-key="a"]')).toBe(aNode);
    expect(list.querySelector<HTMLElement>('[data-recording-key="c"]')).toBe(cNode);
    expect(api.createCount).toBe(0);
    // b stays put (already at index 1), a and c are repositioned.
    expect(stats.moved).toBe(2);
  });

  it("preserves scroll position: untouched DOM nodes are identity-equal across re-renders", () => {
    const api = createApi();
    const big: TestItem[] = Array.from({ length: 50 }, (_, i) => ({
      key: `rec-${i}`,
      title: `Recording ${i}`,
      meta: `${i}s`,
    }));
    reconcileRecordingsList(list, big, api);
    const middle = list.querySelector<HTMLElement>('[data-recording-key="rec-25"]')!;

    api.createCount = 0;
    api.updateCount = 0;
    const refreshed: TestItem[] = big.map((item, i) =>
      i === 25 ? { ...item, meta: "25.5s" } : item,
    );
    reconcileRecordingsList(list, refreshed, api);
    const middleAfter = list.querySelector<HTMLElement>('[data-recording-key="rec-25"]')!;
    expect(middleAfter).toBe(middle);
    expect(middleAfter.querySelector(".rec-meta")!.textContent).toBe("25.5s");
    expect(api.createCount).toBe(0);
  });

  it("handles empty input by clearing existing rows", () => {
    const api = createApi();
    reconcileRecordingsList(list, [
      { key: "a", title: "Alpha", meta: "1s" },
    ], api);
    expect(list.children.length).toBe(1);
    const { stats } = reconcileRecordingsList(list, [], api);
    expect(list.children.length).toBe(0);
    expect(stats.removed).toBe(1);
  });

  it("removes stale empty-state placeholders (no data-recording-key)", () => {
    const stale = document.createElement("div");
    stale.className = "recordings-empty-state";
    stale.textContent = "No recordings yet.";
    list.appendChild(stale);
    const realRow = document.createElement("li");
    realRow.dataset.recordingKey = "real-1";
    list.appendChild(realRow);

    const api = createApi();
    reconcileRecordingsList(list, [
      { key: "real-1", title: "Real", meta: "1s" },
      { key: "real-2", title: "Real 2", meta: "2s" },
    ], api);
    expect(getKeys(list)).toEqual(["real-1", "real-2"]);
    expect(list.querySelector(".recordings-empty-state")).toBeNull();
  });
});