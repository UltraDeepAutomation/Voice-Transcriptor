const { existsSync, readdirSync, lstatSync, chmodSync } = require("node:fs");
const path = require("node:path");

const distDir = path.join(__dirname, "dist");

function unlockTree(root) {
  let changed = 0;

  const visit = (entryPath) => {
    let st;
    try { st = lstatSync(entryPath); } catch { return; }
    if (st.isSymbolicLink()) return;

    const writableMode = st.mode | 0o200;
    if ((st.mode & 0o200) === 0) {
      chmodSync(entryPath, writableMode);
      changed += 1;
    }

    if (!st.isDirectory()) return;
    let entries;
    try { entries = readdirSync(entryPath); } catch { return; }
    for (const name of entries) {
      visit(path.join(entryPath, name));
    }
  };

  visit(root);
  return changed;
}

if (existsSync(distDir)) {
  const changed = unlockTree(distDir);
  if (changed > 0) {
    console.log(`[unlockDist] Restored owner write bit on ${changed} dist entries`);
  }
}
