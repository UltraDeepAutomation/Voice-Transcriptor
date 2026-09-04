/**
 * Conditional polling primitive (SSOT).
 *
 * Every recurring background refresh in the renderer answers a question
 * whose answer is only *observable* under some condition — the Settings
 * pane being on screen, the window not being hidden, a download still
 * running. Before this module each poll expressed that condition its own
 * way, and two of the three did it by waking on a fixed interval and
 * returning early:
 *
 *     setInterval(() => { if (hidden) return; refresh(); }, 2000)
 *
 * That still pays for the wakeup. The main window runs with
 * `backgroundThrottling: false` (needed so recording survives the user
 * alt-tabbing away), which means Chromium does NOT clamp these timers
 * when the window is hidden the way it would in a normal tab. A guard
 * that returns early is therefore a timer firing every 2 s, forever, to
 * decide to do nothing.
 *
 * A gated poll suspends instead: when the gate closes its timer is
 * cleared outright, so a closed gate costs exactly zero wakeups. It
 * re-arms when `sync()` reports the gate open again.
 *
 * The module is pure and timer-injected so the scheduling contract can
 * be unit-tested without real time passing.
 */

export interface PollTimers {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

export interface GatedPollOptions {
  /** Delay between the end of one tick and the start of the next. */
  intervalMs: number;
  /** Gate. Re-evaluated before every tick and on every `sync()`. */
  shouldRun: () => boolean;
  /** The work. A rejected promise is reported, never left unhandled. */
  tick: () => void | Promise<void>;
  /** Label used in the console warning when a tick throws. */
  name?: string;
  /** Injection seam for tests; defaults to the global timers. */
  timers?: PollTimers;
  /** Reporter for a failing tick; defaults to `console.warn`. */
  onError?: (error: unknown, name: string) => void;
}

export interface GatedPoll {
  /**
   * Re-evaluate the gate. Arms the poll if it is open and idle, cancels
   * the pending wakeup if it has closed. Idempotent and cheap — call it
   * from any state change that could move the gate (view switch,
   * visibility change, a download starting or finishing).
   */
  sync(): void;
  /**
   * Run a tick now if the gate is open, then resume the cadence from
   * that point. Used when a state change makes the current data stale
   * rather than merely resuming interest in it.
   *
   * A tick already in flight was started against the OLD state, so it
   * cannot be the answer to this request: the refresh is queued and runs
   * as soon as that tick finishes. Dropping it instead — which is what
   * an `inFlight` early return amounts to — left the network indicator,
   * and with it `isRemoteProviderReachable`, holding a value known to be
   * wrong for a whole interval, and a recording started in that window
   * went to an unreachable cloud instead of falling back to local.
   */
  refreshNow(): void;
  /** Cancel permanently. Safe to call more than once. */
  stop(): void;
  /** True while a wakeup is scheduled or a tick is in flight. */
  readonly active: boolean;
}

const defaultTimers: PollTimers = {
  setTimeout: (handler, timeoutMs) =>
    globalThis.setTimeout(handler, timeoutMs) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function createGatedPoll(options: GatedPollOptions): GatedPoll {
  const {
    intervalMs,
    shouldRun,
    tick,
    name = "poll",
    timers = defaultTimers,
    onError = (error: unknown, label: string) =>
      console.warn(`[${label}] tick failed`, error),
  } = options;

  let handle: number | null = null;
  let stopped = false;
  let inFlight = false;
  /** A `refreshNow` that arrived while a tick was already running. */
  let refreshQueued = false;

  const cancel = (): void => {
    if (handle === null) return;
    timers.clearTimeout(handle);
    handle = null;
  };

  const arm = (): void => {
    // Chained timeouts, not setInterval: a tick slower than the
    // interval must delay the next wakeup rather than have wakeups
    // queue up behind it. With setInterval a backend that answers in
    // 3 s under a 2 s cadence accumulates pending callbacks forever.
    if (stopped || handle !== null || inFlight) return;
    handle = timers.setTimeout(() => {
      handle = null;
      void run();
    }, intervalMs);
  };

  const run = async (): Promise<void> => {
    if (stopped || inFlight) return;
    if (!shouldRun()) return; // Gate closed while the wakeup was pending.
    inFlight = true;
    try {
      await tick();
    } catch (error) {
      onError(error, name);
    } finally {
      inFlight = false;
      const catchUp = refreshQueued;
      refreshQueued = false;
      // Re-check the gate: a tick can be what closes it (a download
      // finishing, a view switching away mid-request).
      if (!stopped && shouldRun()) {
        if (catchUp) {
          // A refresh that arrived mid-tick. The tick that just
          // finished read the old state, so it did not answer it.
          cancel();
          void run();
        } else {
          arm();
        }
      }
    }
  };

  return {
    sync(): void {
      if (stopped) return;
      if (shouldRun()) {
        arm();
      } else {
        cancel();
      }
    },
    refreshNow(): void {
      if (stopped || !shouldRun()) return;
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      cancel();
      void run();
    },
    stop(): void {
      stopped = true;
      cancel();
    },
    get active(): boolean {
      return handle !== null || inFlight || refreshQueued;
    },
  };
}
