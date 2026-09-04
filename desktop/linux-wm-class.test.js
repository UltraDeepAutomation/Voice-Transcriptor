"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseLinuxWmClass } = require("./linux-wm-class");

test("the classic two-token form splits where it always did", () => {
  assert.deepEqual(parseLinuxWmClass("firefox.Firefox"), {
    wmClass: "firefox.Firefox",
    instanceName: "firefox",
    className: "Firefox",
  });
  assert.deepEqual(parseLinuxWmClass("google-chrome.Google-chrome"), {
    wmClass: "google-chrome.Google-chrome",
    instanceName: "google-chrome",
    className: "Google-chrome",
  });
});

test("the reverse-DNS form — every modern GNOME / Flatpak window — no longer degrades to two junk tokens", () => {
  // `raw.split(".", 2)` gave instanceName "org" and className "gnome", and
  // pickLinuxTargetName then recorded "gnome" as the window to reactivate
  // before pasting.
  assert.deepEqual(parseLinuxWmClass("org.gnome.Nautilus.Org.gnome.Nautilus"), {
    wmClass: "org.gnome.Nautilus.Org.gnome.Nautilus",
    instanceName: "org.gnome.Nautilus",
    className: "Org.gnome.Nautilus",
  });
  assert.deepEqual(parseLinuxWmClass("org.telegram.desktop.Org.telegram.desktop"), {
    wmClass: "org.telegram.desktop.Org.telegram.desktop",
    instanceName: "org.telegram.desktop",
    className: "Org.telegram.desktop",
  });
});

test("a reverse-DNS instance with a short class splits at the last dot", () => {
  assert.deepEqual(parseLinuxWmClass("org.gnome.Nautilus.Nautilus"), {
    wmClass: "org.gnome.Nautilus.Nautilus",
    instanceName: "org.gnome.Nautilus",
    className: "Nautilus",
  });
  assert.deepEqual(parseLinuxWmClass("com.visualstudio.code.Code"), {
    wmClass: "com.visualstudio.code.Code",
    instanceName: "com.visualstudio.code",
    className: "Code",
  });
});

test("no dot at all is an instance with no class, and the raw value always survives", () => {
  assert.deepEqual(parseLinuxWmClass("xterm"), {
    wmClass: "xterm",
    instanceName: "xterm",
    className: "",
  });
  for (const raw of ["", "   ", null, undefined]) {
    const parsed = parseLinuxWmClass(raw);
    assert.equal(parsed.wmClass, "");
    assert.equal(parsed.instanceName, "");
    assert.equal(parsed.className, "");
  }
});

test("nothing is ever dropped: the halves rejoin to the raw value", () => {
  for (const raw of [
    "firefox.Firefox",
    "org.gnome.Nautilus.Org.gnome.Nautilus",
    "org.gnome.Nautilus.Nautilus",
    "a.b.c.d.e",
    "com.visualstudio.code.Code",
  ]) {
    const { instanceName, className } = parseLinuxWmClass(raw);
    assert.equal(`${instanceName}.${className}`, raw, `round trip failed for "${raw}"`);
  }
});

test("the discarded-tail bug is gone, stated as the property that failed", () => {
  // The whole class of defect in one assertion: split-with-limit drops
  // everything past the limit.
  const raw = "org.gnome.Nautilus.Org.gnome.Nautilus";
  const withLimit = raw.split(".", 2);
  assert.deepEqual(withLimit, ["org", "gnome"], "this is what the old code saw");
  const parsed = parseLinuxWmClass(raw);
  assert.notEqual(parsed.instanceName, "org");
  assert.notEqual(parsed.className, "gnome");
});
