/**
 * Readable text for a thrown value (SSOT).
 *
 * The renderer reports failures as `console.warn("context", err)`. That
 * is idiomatic and correct — except that what reaches the support log is
 * the *formatted* string, and the browser formats a caught error as
 * `[object DOMException]` or `[object Object]`. The context survives;
 * the reason does not.
 *
 * A concrete cost: every recording this app made fell back from
 * AudioWorklet to the deprecated ScriptProcessor capture path, and the
 * only evidence was
 *
 *     [renderer WARN] AudioWorklet capture init failed;
 *                     falling back to ScriptProcessor [object DOMException]
 *
 * The fallback was visible; the cause (a CSP refusing a `data:` script)
 * was not, and finding it took reading the build output rather than the
 * log that was supposed to say so.
 *
 * Fixing this at ~25 call sites would fix the 25 that exist today.
 * `installErrorAwareConsole` fixes the formatting once, for every site
 * present and future, which is the only version of this that stays
 * fixed.
 */

/** Longest rendered error text. Bounds a pathological `message`. */
export const MAX_ERROR_TEXT = 400;

/**
 * Render any thrown value as diagnostic text.
 *
 * `DOMException` and `Error` both carry `name` and `message`, and both
 * stringify uselessly through object formatting — the name is what
 * distinguishes `NotAllowedError` (permission) from `AbortError`
 * (cancelled) from `NotSupportedError` (CSP refused the module), so it
 * leads. Non-errors fall through to their own string form, which is
 * already meaningful for strings and numbers.
 */
export function describeError(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  let text: string;
  if (value instanceof Error || (typeof DOMException !== "undefined" && value instanceof DOMException)) {
    const name = String(value.name || "Error");
    const message = String(value.message || "").trim();
    text = message ? `${name}: ${message}` : name;
  } else if (typeof value === "object") {
    // A plain object formats as "[object Object]" too. Prefer its own
    // name/message pair when it has one (thrown DTOs, structured-clone
    // copies of errors across a worker boundary), else JSON.
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (name || message) {
      text = message ? `${name || "Error"}: ${message}` : name;
    } else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value); // circular / unserialisable
      }
    }
  } else {
    text = String(value);
  }
  return text.length > MAX_ERROR_TEXT
    ? `${text.slice(0, MAX_ERROR_TEXT)}…(+${text.length - MAX_ERROR_TEXT} chars)`
    : text;
}

/** True for values the browser would render as "[object …]". */
export function needsErrorText(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Error) return true;
  if (typeof DOMException !== "undefined" && value instanceof DOMException) return true;
  return typeof value === "object";
}

type ConsoleMethod = (...args: unknown[]) => void;

export interface ConsoleLike {
  warn: ConsoleMethod;
  error: ConsoleMethod;
}

/**
 * Make `console.warn` / `console.error` render errors readably.
 *
 * Only the two levels that carry failures are wrapped, and only
 * error-shaped arguments are rewritten — strings, numbers and the
 * leading context message pass through untouched, so existing call
 * sites read exactly as before with the reason appended instead of
 * `[object DOMException]`.
 *
 * Idempotent: re-installing over an already-wrapped console is a no-op,
 * so a hot reload cannot stack wrappers and double-render.
 */
export function installErrorAwareConsole(target: ConsoleLike): void {
  const marked = target as ConsoleLike & { __transcriptorErrorAware?: boolean };
  if (marked.__transcriptorErrorAware) return;
  for (const level of ["warn", "error"] as const) {
    const original = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      original(...args.map((a) => (needsErrorText(a) ? describeError(a) : a)));
    };
  }
  marked.__transcriptorErrorAware = true;
}
