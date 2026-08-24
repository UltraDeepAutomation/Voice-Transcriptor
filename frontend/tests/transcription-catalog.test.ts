import { describe, expect, it } from "vitest";
import {
  buildTranscriptionCatalog,
  groupFromWire,
  isLocalGroup,
  transcriptionModelLabel,
  wireProviderForGroup,
} from "../src/transcription-catalog";

const input = {
  whisperModels: ["tiny", "base", "small", "medium", "large-v3"],
  gigaamModels: ["gigaam-v3-e2e-rnnt", "gigaam-v3-rnnt"],
  engines: { whisper: true, gigaam: true },
  deepgramModels: ["nova-3", "nova-2"],
  openrouterModels: ["google/gemini-2.5-flash"],
};

describe("buildTranscriptionCatalog", () => {
  it("exposes labeled whisper models as their own group", () => {
    const groups = buildTranscriptionCatalog(input);
    const whisper = groups.find((g) => g.id === "local-whisper")!;
    expect(whisper.label).toBe("Local Whisper");
    expect(whisper.models.map((m) => m.label)).toEqual([
      "Whisper Tiny",
      "Whisper Base",
      "Whisper Small",
      "Whisper Medium",
      "Whisper Large-v3",
    ]);
  });

  it("exposes gigaam as a separate group with both models", () => {
    const groups = buildTranscriptionCatalog(input);
    const gigaam = groups.find((g) => g.id === "gigaam")!;
    expect(gigaam.models.map((m) => m.label)).toEqual([
      "GigaAM v3 E2E RNNT",
      "GigaAM v3 RNNT",
    ]);
  });

  it("marks local models unavailable when their engine is missing", () => {
    const groups = buildTranscriptionCatalog({ ...input, engines: { whisper: true, gigaam: false } });
    const gigaam = groups.find((g) => g.id === "gigaam")!;
    expect(gigaam.models.every((m) => !m.available)).toBe(true);
    const whisper = groups.find((g) => g.id === "local-whisper")!;
    expect(whisper.models.every((m) => m.available)).toBe(true);
  });
});

describe("wire mapping", () => {
  it("maps gigaam group to wire provider local", () => {
    expect(wireProviderForGroup("gigaam")).toBe("local");
    expect(wireProviderForGroup("local-whisper")).toBe("local");
    expect(wireProviderForGroup("deepgram")).toBe("deepgram");
    expect(wireProviderForGroup("openrouter")).toBe("openrouter");
    expect(wireProviderForGroup("")).toBe("");
  });

  it("recovers the UI group from a persisted wire selection", () => {
    expect(groupFromWire("local", "small")).toBe("local-whisper");
    expect(groupFromWire("local", "gigaam-v3-rnnt")).toBe("gigaam");
    expect(groupFromWire("deepgram", "nova-3")).toBe("deepgram");
    expect(groupFromWire("openrouter", "x")).toBe("openrouter");
    expect(groupFromWire("", "")).toBe("local-whisper");
  });

  it("classifies local groups for the live assist path", () => {
    expect(isLocalGroup("gigaam")).toBe(true);
    expect(isLocalGroup("local-whisper")).toBe(true);
    expect(isLocalGroup("deepgram")).toBe(false);
  });
});

describe("transcriptionModelLabel", () => {
  it("labels known ids and falls back to the raw id", () => {
    expect(transcriptionModelLabel("local-whisper", "small")).toBe("Whisper Small");
    expect(transcriptionModelLabel("gigaam", "gigaam-v3-rnnt")).toBe("GigaAM v3 RNNT");
    expect(transcriptionModelLabel("deepgram", "nova-3")).toBe("nova-3");
  });
});
