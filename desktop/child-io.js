"use strict";

// SSOT for "how does a child process's text output get decoded".
//
// `runCommand` used to decode every child stream as UTF-8 unconditionally
// while separately teaching PowerShell to *emit* UTF-8. The two halves of
// that decision lived apart, and a third invocation broke the rule
// silently: `cscript //U <script>.vbs` — `//U` means "use Unicode for
// redirected I/O", i.e. cscript writes UTF-16LE. Decoded as UTF-8 the
// receipt `OK:vbs-paste` arrives as `O\0K\0:\0v\0…`, so
// `isVbsPasteSuccess` returned false for every SUCCESSFUL Windows paste
// and the ladder fell through to the PowerShell fallback, which sent a
// second Ctrl+V. The user got the transcript twice — the duplication that
// was previously blamed on double queueing and "fixed" with a
// recordingId dedupe that could not possibly catch it, because both
// pastes happen inside one task.
//
// The encoding is therefore derived from the command line itself, in one
// place, so it cannot drift from the flag that causes it.

/** `powershell`/`pwsh` are made to emit UTF-8 with this prelude. */
const POWERSHELL_UTF8_PRELUDE =
  "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";

/**
 * The encoding a child's stdout/stderr will actually be written in.
 *
 * @returns {"utf8"|"utf16le"}
 */
function childStreamEncoding(cmd, args = []) {
  const base = String(cmd || "").toLowerCase().replace(/\.exe$/, "");
  if (base === "cscript" || base === "wscript") {
    // //U is cscript's own declaration that redirected I/O is Unicode
    // (UTF-16LE). Honour what the command line says rather than assuming.
    const unicode = (args || []).some((a) => String(a || "").toLowerCase() === "//u");
    if (unicode) return "utf16le";
  }
  return "utf8";
}

/**
 * cscript //U prefixes redirected output with a UTF-16LE BOM, which
 * survives decoding as U+FEFF and would sit in front of the first
 * protocol marker. Strip it once, where the decoding happens.
 */
function stripBom(text) {
  const s = String(text == null ? "" : text);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * PowerShell writes stdout in the system OEM code page (CP866 / CP1251 /
 * CP932 / …) unless told otherwise, which turns Cyrillic and CJK window
 * titles into mojibake. Returns args with the UTF-8 prelude prepended to
 * the `-Command` script; any other command line is returned untouched
 * (same array identity, so callers can tell nothing changed).
 */
function withUtf8OutputPrelude(cmd, args = []) {
  const base = String(cmd || "").toLowerCase().replace(/\.exe$/, "");
  if (base !== "powershell" && base !== "pwsh") return args;
  const cmdIdx = args.findIndex((a) => String(a || "").toLowerCase() === "-command");
  if (cmdIdx < 0 || cmdIdx + 1 >= args.length) return args;
  const script = args[cmdIdx + 1];
  if (typeof script !== "string" || script.startsWith(POWERSHELL_UTF8_PRELUDE)) return args;
  const next = args.slice();
  next[cmdIdx + 1] = POWERSHELL_UTF8_PRELUDE + script;
  return next;
}

module.exports = {
  POWERSHELL_UTF8_PRELUDE,
  childStreamEncoding,
  stripBom,
  withUtf8OutputPrelude,
};
