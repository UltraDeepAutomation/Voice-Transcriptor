/**
 * Copy that more than one surface shows.
 *
 * Every string here used to exist twice: once typed into
 * ``index.html`` as the state the user sees before anything runs, and
 * once as a literal in ``main.tsx`` where the renderer puts that state
 * back. Nothing connected the two, and the audit found four of them
 * already carrying three copies each ("Choose a recording from the left
 * list…", "No recordings match the current search.", "Transcription
 * will appear here…", the Upload empty state). A copy edit landed on
 * one surface and not the other reads, to the user, as two different
 * screens for one situation.
 *
 * The rule this file establishes is the one the project already applies
 * to numbers (``UI_TOKENS`` → ``applyAutoStopSilenceBounds``), to the
 * language list (``#uploadLanguage`` filled from ``#language``) and to
 * the provider select (rebuilt from the catalogue): **the markup
 * carries no copy of its own**, and ``applyStaticUiCopy`` writes it at
 * boot from the single declaration below.
 *
 * What does NOT belong here: a string with exactly one writer and one
 * reader. Naming those buys nothing and costs a jump.
 */
export const UI_COPY = {
  /** ``#finalOutput`` — the Record view's transcript pane. */
  resultPlaceholder: "Transcription will appear here...",
  recordings: {
    /** ``#recordingContent`` — History's transcript pane. */
    viewerPlaceholder: "Choose a recording from the left list...",
    /** ``#recordingTitleLabel`` — the pane title beside it. */
    viewerTitlePlaceholder: "Choose a recording",
    /** Shown by the list, the viewer and the search-cleared path. */
    noSearchMatches: "No recordings match the current search.",
  },
  upload: {
    emptyTitle: "No files yet",
    emptyLead: "Drop audio or video on the left.",
    /**
     * Split from the lead because the markup renders the two on
     * separate lines with ``<b>History</b>`` inside the second. Two
     * text nodes and an element, built with DOM calls — the previous
     * code re-assigned ``innerHTML`` on every queue render to restore
     * exactly this.
     */
    emptyTailBefore: "Each completed file is saved to ",
    emptyTailStrong: "History",
    emptyTailAfter: " automatically.",
    /**
     * The file-dialog filter, on the hidden ``<input type=file>`` in the
     * markup and on the one the retry path constructs.
     */
    fileAccept: "audio/*,video/*",
  },
} as const;

/**
 * Write every string above into the markup.
 *
 * Called once at boot, after ``applyBackendBootstrap`` so the format
 * hint can be rendered from the backend's own extension list. Missing
 * elements are skipped rather than thrown on: this function must not be
 * the reason a view fails to start.
 */
export function applyStaticUiCopy(doc: Document): void {
  const finalOutput = doc.getElementById("finalOutput");
  if (finalOutput) finalOutput.setAttribute("data-placeholder", UI_COPY.resultPlaceholder);

  const recordingContent = doc.getElementById("recordingContent");
  if (recordingContent) {
    recordingContent.setAttribute("data-placeholder", UI_COPY.recordings.viewerPlaceholder);
  }
  const recordingTitle = doc.getElementById("recordingTitleLabel");
  if (recordingTitle) recordingTitle.textContent = UI_COPY.recordings.viewerTitlePlaceholder;

  const emptyTitle = doc.querySelector("#uploadEmptyState .upload-empty-state-title");
  if (emptyTitle) emptyTitle.textContent = UI_COPY.upload.emptyTitle;
  const emptySub = doc.querySelector("#uploadEmptyState .upload-empty-state-sub");
  if (emptySub) {
    const strong = doc.createElement("b");
    strong.textContent = UI_COPY.upload.emptyTailStrong;
    emptySub.replaceChildren(
      doc.createTextNode(UI_COPY.upload.emptyLead),
      doc.createElement("br"),
      doc.createTextNode(UI_COPY.upload.emptyTailBefore),
      strong,
      doc.createTextNode(UI_COPY.upload.emptyTailAfter),
    );
  }

  const fileInput = doc.getElementById("uploadLargeFileInput") as HTMLInputElement | null;
  if (fileInput) fileInput.accept = UI_COPY.upload.fileAccept;
}

/**
 * The "WAV · MP3 · …" line under the drop zone.
 *
 * It was ten extensions typed into the markup while the backend accepts
 * eighteen (``backend/main.py`` ``ACCEPTED_AUDIO_EXTS``, reported in the
 * bootstrap payload and already used by the renderer to *validate* the
 * drop). The list the user is shown and the list the app enforces are
 * now the same list. Until the backend has reported one, nothing is
 * claimed: the line is hidden rather than filled with a guess.
 */
export function renderAcceptedFormatsHint(doc: Document, exts: Iterable<string>): void {
  const el = doc.getElementById("uploadAcceptedFormats");
  if (!el) return;
  const labels = Array.from(exts)
    .map((ext) => String(ext).replace(/^\./, "").trim().toUpperCase())
    .filter(Boolean)
    .sort();
  if (labels.length === 0) {
    el.textContent = "";
    (el as HTMLElement).hidden = true;
    return;
  }
  (el as HTMLElement).hidden = false;
  el.textContent = labels.join(" · ");
}
