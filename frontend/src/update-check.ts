/**
 * Update detection (Level 1 — detect only, no download/install).
 *
 * Silent auto-update via electron-updater is NOT possible for this app:
 * macOS rejects update payloads that are not signed with a real Apple
 * Developer ID certificate, and the project ships ad-hoc signatures.
 * Until that changes, this module answers one question — "is there a
 * newer release on GitHub?" — and the Settings UI links to the release
 * page. The user downloads it themselves, exactly as today, but without
 * having to poll the repo manually.
 *
 * SSOT: version + repo slug are injected at build time from
 * desktop/package.json (see vite.config.ts __APP_UPDATE_META__) — this
 * module never hard-codes either.
 *
 * Pure logic (version compare, release parsing, check scheduling) is
 * separated from network I/O so every rule is unit-tested; fetch is
 * injected.
 */

export interface UpdateMeta {
  version: string;
  /** "owner/repo" — GitHub releases API target. */
  repoSlug: string;
}

export interface LatestRelease {
  version: string;
  /** Human-facing release page (not the asset URL). */
  htmlUrl: string;
}

/** Compare two dotted numeric versions ("1.10.0" vs "1.9.2"). Non-numeric segments compare lexically. Returns >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "").trim().split(".");
  const pb = String(b || "").trim().split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na - nb;
      continue;
    }
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * Extract {version, htmlUrl} from a GitHub /releases/latest payload.
 * Drafts and prereleases never appear in that endpoint; a missing tag
 * name or html_url yields null so callers can treat it as "unknown"
 * rather than "up to date".
 */
export function parseLatestRelease(payload: unknown): LatestRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as { tag_name?: unknown; html_url?: unknown; draft?: unknown };
  if (obj.draft === true) return null;
  const rawTag = typeof obj.tag_name === "string" ? obj.tag_name.trim() : "";
  const htmlUrl = typeof obj.html_url === "string" ? obj.html_url : "";
  if (!rawTag || !htmlUrl) return null;
  // Tags conventionally carry a leading "v"; strip exactly one.
  const version = /^v/i.test(rawTag) ? rawTag.slice(1) : rawTag;
  if (!version) return null;
  return { version, htmlUrl };
}

export type UpdateCheckResult =
  | { status: "update-available"; latest: LatestRelease }
  | { status: "up-to-date" }
  | { status: "unknown"; reason: string };

/** Run one check against GitHub. Network errors degrade to "unknown". */
export async function checkForUpdate(
  meta: UpdateMeta,
  fetchImpl: typeof fetch,
): Promise<UpdateCheckResult> {
  if (!meta.repoSlug) {
    return { status: "unknown", reason: "repository coordinates unavailable" };
  }
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${meta.repoSlug}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      return { status: "unknown", reason: `GitHub API responded ${res.status}` };
    }
    const latest = parseLatestRelease(await res.json());
    if (!latest) return { status: "unknown", reason: "unrecognised release payload" };
    if (compareVersions(latest.version, meta.version) > 0) {
      return { status: "update-available", latest };
    }
    return { status: "up-to-date" };
  } catch (e) {
    return {
      status: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Throttle rule for the passive boot-time check: at most once per day. */
export function shouldAutoCheck(nowMs: number, lastCheckedMs: number): boolean {
  if (!Number.isFinite(lastCheckedMs) || lastCheckedMs <= 0) return true;
  return nowMs - lastCheckedMs >= CHECK_INTERVAL_MS;
}
