"use strict";

/**
 * Split `wmctrl -lpGx`'s WM_CLASS column into its two halves.
 *
 * ── The format ────────────────────────────────────────────────────────
 *
 * X11's WM_CLASS property is TWO strings — the instance name and the class
 * name. `wmctrl -x` prints them joined with a single "." and gives no way to
 * tell where the join is, because either half may itself contain dots:
 *
 *   firefox.Firefox                            classic: one dot
 *   org.gnome.Nautilus.Org.gnome.Nautilus      reverse-DNS, both halves
 *   org.gnome.Nautilus.Nautilus                reverse-DNS instance, short class
 *
 * The previous implementation was `raw.split(".", 2)`. JavaScript's split
 * limit DISCARDS the tail rather than keeping it in the last element (unlike
 * Python's `split(sep, maxsplit)`), so the reverse-DNS case — every modern
 * GNOME and Flatpak application — produced instance "org" and class "gnome",
 * and `pickLinuxTargetName` then recorded "gnome" as the window to bring back
 * to the front before pasting.
 *
 * ── The rule ──────────────────────────────────────────────────────────
 *
 * 1. Both halves identical apart from case (`org.gnome.Nautilus` /
 *    `Org.gnome.Nautilus`) — the overwhelmingly common reverse-DNS shape.
 *    Split down the middle.
 * 2. Otherwise split at the LAST dot: the class half is conventionally a
 *    single capitalised token, and the instance half is what carries the
 *    reverse-DNS prefix.
 * 3. No dot at all: it is the instance, and there is no class.
 *
 * The raw string is always kept as `wmClass`, and `scoreLinuxWindowMatch`
 * weights it too, so a shape this rule reads differently than the window
 * manager intended still has an exact-match path.
 *
 * Pure module: `node --test` drives it directly.
 */

function parseLinuxWmClass(value) {
  const raw = String(value || "").trim();
  const segments = raw.split(".");

  let instanceName = raw;
  let className = "";

  if (segments.length >= 2) {
    // Rule 1: an even number of segments whose halves match case-insensitively.
    if (segments.length % 2 === 0) {
      const half = segments.length / 2;
      const left = segments.slice(0, half).join(".");
      const right = segments.slice(half).join(".");
      if (left.toLowerCase() === right.toLowerCase()) {
        return { wmClass: raw, instanceName: left.trim(), className: right.trim() };
      }
    }
    // Rule 2: last dot.
    const cut = raw.lastIndexOf(".");
    instanceName = raw.slice(0, cut);
    className = raw.slice(cut + 1);
  }

  return { wmClass: raw, instanceName: instanceName.trim(), className: className.trim() };
}

module.exports = { parseLinuxWmClass };
