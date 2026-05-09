#!/bin/bash
# ============================================================================
#  Transcriptor - Linux Build
#  Builds the Electron app as an AppImage for Linux x64.
#  Usage: chmod +x build.sh && ./build.sh
# ============================================================================
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

echo ""
echo "  ========================================"
echo "    Transcriptor - Linux Build"
echo "  ========================================"
echo ""

# -- 1. Pre-flight --
echo "[1/6] Pre-flight checks..."
command -v node &>/dev/null || { echo "ERROR: Node.js not found. Install from https://nodejs.org"; exit 1; }
command -v npm &>/dev/null || { echo "ERROR: npm not found. Install Node.js"; exit 1; }
echo "  Node.js $(node --version), npm $(npm --version)"

# -- 2. Clean --
echo "[2/6] Cleaning stale builds..."
rm -rf "$ROOT_DIR/desktop/dist/linux-unpacked" "$ROOT_DIR/desktop/dist"/*.AppImage 2>/dev/null || true

# -- 3. Frontend deps --
echo "[3/6] Checking frontend dependencies..."
if [ ! -d "$ROOT_DIR/frontend/node_modules" ]; then
    echo "  Installing frontend npm deps..."
    (cd "$ROOT_DIR/frontend" && npm install --silent)
fi

# -- 4. Desktop deps --
echo "[4/6] Checking desktop dependencies..."
if [ ! -d "$ROOT_DIR/desktop/node_modules" ]; then
    echo "  Installing desktop npm deps..."
    (cd "$ROOT_DIR/desktop" && npm install --silent)
fi

# -- 5. Build --
echo "[5/6] Building Electron app + AppImage..."
(cd "$ROOT_DIR/desktop" && npm run dist:linux)

# -- 6. Collect --
echo "[6/6] Collecting AppImage..."
mkdir -p "$ROOT_DIR/dist"
rm -f "$ROOT_DIR/dist"/Transcriptor-*.AppImage 2>/dev/null || true
for f in "$ROOT_DIR/desktop/dist"/*.AppImage; do
    [ -f "$f" ] || continue
    cp "$f" "$ROOT_DIR/dist/"
    echo "  $(basename "$f")"
done

# Cleanup
rm -rf "$ROOT_DIR/desktop/dist/linux-unpacked" 2>/dev/null || true
rm -f "$ROOT_DIR/desktop/dist"/*.AppImage.blockmap 2>/dev/null || true

echo ""
echo "  ========================================"
echo "    Build complete!"
echo "  ========================================"
echo ""
echo "  AppImage: dist/Transcriptor-1.1.12.AppImage"
echo ""
echo "  To run:"
echo "    chmod +x dist/Transcriptor-1.1.12.AppImage"
echo "    ./dist/Transcriptor-1.1.12.AppImage"
echo ""
echo "  Or double-click in your file manager."
echo ""
