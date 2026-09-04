/**
 * What the renderer is allowed to do after trying to read the upload queue
 * from the backend.
 *
 * The backend replaces `ui/upload_queue.json` wholesale on `PUT`
 * (`atomic_write_json(UPLOAD_QUEUE_STATE_PATH, ...)` — it is not a merge), so
 * an in-memory queue that is empty because the `GET` failed is not "the queue
 * is empty", it is "we do not know what the queue is". Writing it back
 * destroys every completed upload's transcript with no way to recover: the
 * legacy localStorage copy is removed on the first successful restore, and the
 * "snapshot loaded" latch closes the door on a second attempt in the same
 * session.
 *
 * The rule therefore is: never write state we did not read. This module is the
 * single place that states it, so both the restore path and its test read the
 * same decision instead of re-deriving it from control flow inside a 200-line
 * async function.
 */

export type UploadQueueRestoreReason =
  | "server-read-failed"
  | "server-snapshot"
  | "legacy-snapshot";

export interface UploadQueueRestoreInput {
  /** The `GET /api/ui/upload-queue` call resolved (any payload, including empty). */
  serverReadOk: boolean;
  /** The queue is empty after whatever the server returned was applied. */
  queueEmptyAfterServer: boolean;
  /** A parseable pre-backend snapshot exists in localStorage. */
  legacyAvailable: boolean;
}

export interface UploadQueueRestoreDecision {
  /** Adopt the localStorage snapshot into the in-memory queue. */
  adoptLegacy: boolean;
  /**
   * Flip `uploadQueueSnapshotLoaded`. This latch gates every later `PUT`, so
   * it must stay false while the server's state is unknown — otherwise the
   * next queue mutation persists a queue built on nothing.
   */
  markLoaded: boolean;
  /** Persist the in-memory queue back to the backend right now. */
  persist: boolean;
  /** Why, for the trace line and for the user-facing notice. */
  reason: UploadQueueRestoreReason;
}

export function decideUploadQueueRestore(
  input: UploadQueueRestoreInput,
): UploadQueueRestoreDecision {
  if (!input.serverReadOk) {
    return {
      adoptLegacy: false,
      markLoaded: false,
      persist: false,
      reason: "server-read-failed",
    };
  }
  const adoptLegacy = input.queueEmptyAfterServer && input.legacyAvailable;
  return {
    adoptLegacy,
    markLoaded: true,
    persist: true,
    reason: adoptLegacy ? "legacy-snapshot" : "server-snapshot",
  };
}

/**
 * The legacy localStorage snapshot is the only copy of the queue that survives
 * a backend that cannot be reached, so it may only be dropped once the backend
 * has proven it holds the same data — i.e. after a write that actually
 * succeeded. This mirrors the rule above from the other side.
 */
export function shouldDropLegacyUploadQueueSnapshot(input: {
  persisted: boolean;
  saveOk: boolean;
}): boolean {
  return input.persisted && input.saveOk;
}

/** User-facing text for the one outcome that leaves the queue unknown. */
export const UPLOAD_QUEUE_RESTORE_FAILED_STATUS =
  "Upload history could not be loaded — the backend did not answer. Nothing was overwritten.";
