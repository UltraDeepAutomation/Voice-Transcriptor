const { existsSync, readdirSync, lstatSync, chmodSync } = require("node:fs");
const path = require("node:path");

const distDir = path.join(__dirname, "dist");

// A path that VANISHED between the readdir and the stat is not a problem —
// electron-builder rewrites this tree while it works. A path that exists and
// cannot be read or chmod'd IS one: the build carries on and dies later,
// inside electron-builder, with an EACCES that names a file and gives no
// hint that the unlock pass silently skipped it. Distinguish the two, and
// report the second at the moment it is still attributable.
function isMissing(err) {
  const code = err && err.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function unlockTree(root) {
  let changed = 0;
  const skipped = [];

  const visit = (entryPath) => {
    let st;
    try {
      st = lstatSync(entryPath);
    } catch (e) {
      if (!isMissing(e)) skipped.push(`${entryPath}: ${e.code || e.message}`);
      return;
    }
    if (st.isSymbolicLink()) return;

    if ((st.mode & 0o200) === 0) {
      try {
        chmodSync(entryPath, st.mode | 0o200);
        changed += 1;
      } catch (e) {
        if (!isMissing(e)) skipped.push(`${entryPath}: ${e.code || e.message}`);
      }
    }

    if (!st.isDirectory()) return;
    let entries;
    try {
      entries = readdirSync(entryPath);
    } catch (e) {
      if (!isMissing(e)) skipped.push(`${entryPath}: ${e.code || e.message}`);
      return;
    }
    for (const name of entries) {
      visit(path.join(entryPath, name));
    }
  };

  visit(root);
  return { changed, skipped };
}

if (existsSync(distDir)) {
  const { changed, skipped } = unlockTree(distDir);
  if (changed > 0) {
    console.log(`[unlockDist] Restored owner write bit on ${changed} dist entries`);
  }
  if (skipped.length > 0) {
    console.error(
      `[unlockDist] Could not unlock ${skipped.length} path(s); electron-builder will fail on them:`,
    );
    for (const line of skipped.slice(0, 20)) console.error(`  ${line}`);
    if (skipped.length > 20) console.error(`  …and ${skipped.length - 20} more`);
    process.exitCode = 1;
  }
}
