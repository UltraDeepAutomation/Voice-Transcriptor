/**
 * Keyed reconciler for the recordings history sidebar list.
 *
 * Vanilla-DOM recording-list rendering needs to preserve scroll position
 * across background refreshes. ``replaceChildren`` always resets
 * scrollTop to 0, which is the exact bug: "я пролистал пятьсот
 * элементов, а меня откидывает на самый верх". The reconciler below
 * walks the desired item list in order and, for each key, reuses the
 * matching existing row (updating its text in-place) OR inserts a new
 * row at the right position. Rows whose keys are no longer wanted are
 * dropped. The net effect: untouched rows keep the SAME DOM node, so
 * the browser keeps its scroll position, hover state and focus.
 *
 * The actual recording data (titles, badges) is built outside this
 * module — the renderer injects builders at construction time so this
 * module stays pure (no globals, no DOM lookups, no module state).
 *
 * Pure module: no module-level state, no implicit inputs, fully testable
 * with jsdom in isolation.
 */

export interface RecordingRow {
  /** Stable identity across refreshes. Archive-scoped name. */
  key: string;
}

export interface RowBuildApi<T extends RecordingRow> {
  /** Create a fresh row for a not-yet-seen key. */
  create(item: T): HTMLElement;
  /** Mutate an existing row to reflect a refreshed item. May skip work. */
  update(row: HTMLElement, item: T): void;
}

export interface ReconcileStats {
  reused: number;
  created: number;
  removed: number;
  moved: number;
}

export interface ReconcileResult {
  list: HTMLElement;
  stats: ReconcileStats;
}

/**
 * Reconcile ``items`` into ``list`` using ``key`` as the stable identity.
 *
 *   - Rows whose key is in the new list are reused (and passed to
 *     ``update`` to refresh their text in place).
 *   - New keys get a freshly built row inserted at the correct position.
 *   - Keys no longer present are removed at the end (snapshot first —
 *     removing while iterating an HTMLCollection skips siblings).
 *
 * The caller passes an already-built child list element (typically
 * ``<ul id="recordingsList">``) plus a builder API. Returns the same
 * list element for chaining plus a stats object for assertions.
 */
export function reconcileRecordingsList<T extends RecordingRow>(
  list: HTMLElement,
  items: T[],
  api: RowBuildApi<T>,
): ReconcileResult {
  const existingByKey = new Map<string, HTMLElement>();
  for (const node of Array.from(list.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const key = node.dataset.recordingKey;
    if (key && !existingByKey.has(key)) existingByKey.set(key, node);
  }

  const usedKeys = new Set<string>();
  const stats: ReconcileStats = { reused: 0, created: 0, removed: 0, moved: 0 };
  let refNode: ChildNode | null = list.firstChild;

  items.forEach((item) => {
    usedKeys.add(item.key);
    const freshNode = !existingByKey.has(item.key);
    let node = existingByKey.get(item.key);
    if (node) {
      api.update(node, item);
      stats.reused++;
    } else {
      node = api.create(item);
      existingByKey.set(item.key, node);
      stats.created++;
    }
    if (refNode === node) {
      refNode = node.nextSibling;
    } else {
      list.insertBefore(node, refNode);
      // A freshly created node always goes through insertBefore, so
      // that is placement, not movement: "moved" counts an EXISTING
      // node being repositioned, which is the number that says whether
      // reconciling was worth it.
      if (!freshNode) stats.moved++;
    }
  });

  // Snapshot first — removing while iterating a live HTMLCollection
  // skips siblings.
  for (const node of Array.from(list.children)) {
    if (!(node instanceof HTMLElement)) continue;
    const key = node.dataset.recordingKey;
    if (!key || !usedKeys.has(key)) {
      node.remove();
      stats.removed++;
    }
  }

  return { list, stats };
}
