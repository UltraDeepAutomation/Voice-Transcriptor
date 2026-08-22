/**
 * Cross-platform Electron accelerator → Settings keycap label tokens.
 *
 * Electron sends a platform-aware accelerator string back to the renderer
 * ("CommandOrControl+LShift+F9"), but ``acceleratorToDisplayTokens`` is the
 * one place the Settings UI renders it back into user-readable chips. The
 * previous implementation assumed Mac everywhere and printed "Cmd" on
 * Linux/Windows; the canonical normalization step here turns every variant
 * of "CommandOrControl"/"Cmd"/"Meta"/"Super" into the user's actual
 * platform-specific word, while leaving letters/function keys untouched.
 *
 * Pure: no DOM, no globals — directly unit-testable.
 */

export function normalizeAcceleratorForDisplay(acc: string, isMac: boolean): string {
  if (!acc) return acc;
  return acc
    .split("+")
    .map((tok) => {
      const lc = tok.trim().toLowerCase();
      if (isMac) {
        if (lc === "commandorcontrol" || lc === "cmdorctrl") return "Command";
        if (lc === "meta") return "Command";
        return tok.trim();
      }
      if (lc === "command" || lc === "cmd" || lc === "meta") return "Super";
      if (lc === "commandorcontrol" || lc === "cmdorctrl") return "Control";
      return tok.trim();
    })
    .join("+");
}

export function acceleratorToDisplayTokens(acc: string, isMac: boolean): string[] {
  if (!acc) return ["—"];
  const normalized = normalizeAcceleratorForDisplay(acc, isMac);
  const parts = normalized.split("+");
  const labels: string[] = [];
  for (const p of parts) {
    const lc = p.trim().toLowerCase();
    if (isMac && (lc === "command" || lc === "cmd")) { labels.push("Command"); continue; }
    if (!isMac && lc === "super") { labels.push("Super"); continue; }
    if (lc === "control" || lc === "ctrl") { labels.push("Control"); continue; }
    if (lc === "commandorcontrol" || lc === "cmdorctrl") { labels.push(isMac ? "Command" : "Control"); continue; }
    if (lc === "alt" || lc === "option") { labels.push(isMac ? "Option" : "Alt"); continue; }
    if (lc === "shift") { labels.push("Shift"); continue; }
    if (lc === "tab") { labels.push("Tab"); continue; }
    if (lc === "enter" || lc === "return") { labels.push("Return"); continue; }
    if (lc === "esc" || lc === "escape") { labels.push("Esc"); continue; }
    if (lc === "space" || lc === "spacebar") { labels.push("Space"); continue; }
    if (lc === "backspace" || lc === "delete") { labels.push("Delete"); continue; }
    if (lc === "up" || lc === "arrowup") { labels.push("↑"); continue; }
    if (lc === "down" || lc === "arrowdown") { labels.push("↓"); continue; }
    if (lc === "left" || lc === "arrowleft") { labels.push("←"); continue; }
    if (lc === "right" || lc === "arrowright") { labels.push("→"); continue; }
    labels.push(p.trim());
  }
  return labels;
}
