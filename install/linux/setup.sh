#!/usr/bin/env bash
# ============================================================================
#  Transcriptor — One-command Setup for Linux
#  ----------------------------------------------------------------------------
#  Auto-detects the distro's package manager (apt / dnf / pacman / zypper /
#  apk), installs python3, nodejs, ffmpeg, plus a paste-tool
#  (xdotool / ydotool / wtype depending on X11 vs Wayland), creates an
#  app-scoped venv, installs Python + npm deps, builds the Electron
#  frontend, produces an AppImage and drops it into ~/.local/bin with a
#  symlink + a freedesktop .desktop entry so the user can launch from
#  their application menu.
#
#  Usage:
#     chmod +x install/linux/setup.sh && ./install/linux/setup.sh
#
#  Or from repo root: ``./INSTALL.command`` (wrapper will dispatch to
#  this script when running on Linux).
# ============================================================================

set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

print_step()  { printf "\n${CYAN}${BOLD}▸ %s${NC}\n" "$1"; }
print_ok()    { printf "  ${GREEN}✔ %s${NC}\n" "$1"; }
print_warn()  { printf "  ${YELLOW}⚠ %s${NC}\n" "$1"; }
print_fail()  { printf "  ${RED}✖ %s${NC}\n" "$1"; exit 1; }

on_error() {
  local line=$1
  printf "\n${RED}${BOLD}  ✖ Setup failed at line %s. See output above.${NC}\n" "$line"
  exit 1
}
trap 'on_error $LINENO' ERR

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

printf "${BOLD}"
echo  "  ╔══════════════════════════════════════╗"
echo  "  ║     Transcriptor — Linux Setup       ║"
echo  "  ╚══════════════════════════════════════╝"
printf "${NC}"
echo  "  Working directory: $ROOT_DIR"

# ── 1. Detect package manager ──────────────────────────────────────────────
#
# Best-practice Linux installers fan out by package manager name, not
# distro ID — every major distro sticks with ONE manager and helper
# distros (Pop!_OS, Manjaro, EndeavourOS, etc.) inherit the parent's
# manager. ``command -v`` is more reliable than ``/etc/os-release``
# parsing because containers and minimal images often strip the
# release file.
print_step "Detecting package manager..."
PM=""
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    print_warn "not root and sudo not found — package installs may fail"
  fi
fi
for candidate in apt-get dnf pacman zypper apk; do
  if command -v "$candidate" >/dev/null 2>&1; then
    PM="$candidate"
    break
  fi
done
if [ -z "$PM" ]; then
  print_fail "Unsupported distro (no apt/dnf/pacman/zypper/apk). Install Python 3.9+, Node 18+, ffmpeg manually then rerun."
fi
print_ok "Package manager: $PM"

# Map canonical package names onto per-manager names.
#
# ``python3-venv`` is a Debian/Ubuntu quirk — other distros ship venv
# with the base python3 package. ``build-essential`` ditto.
# ``libxkbcommon`` / ``libsecret`` are Electron runtime deps required
# by electron-builder's AppImage output.
declare -A PKG_PYTHON PKG_NODE PKG_FFMPEG PKG_BUILD PKG_ELECTRON_DEPS
PKG_PYTHON[apt-get]="python3 python3-venv python3-pip"
PKG_PYTHON[dnf]="python3 python3-pip"
PKG_PYTHON[pacman]="python python-pip"
PKG_PYTHON[zypper]="python3 python3-pip"
PKG_PYTHON[apk]="python3 py3-pip"
PKG_NODE[apt-get]="nodejs npm"
PKG_NODE[dnf]="nodejs npm"
PKG_NODE[pacman]="nodejs npm"
PKG_NODE[zypper]="nodejs npm"
PKG_NODE[apk]="nodejs npm"
PKG_FFMPEG[apt-get]="ffmpeg"
PKG_FFMPEG[dnf]="ffmpeg"
PKG_FFMPEG[pacman]="ffmpeg"
PKG_FFMPEG[zypper]="ffmpeg"
PKG_FFMPEG[apk]="ffmpeg"
PKG_BUILD[apt-get]="build-essential"
PKG_BUILD[dnf]="gcc gcc-c++ make"
PKG_BUILD[pacman]="base-devel"
PKG_BUILD[zypper]="gcc gcc-c++ make"
PKG_BUILD[apk]="build-base"
# Electron AppImage runtime: libx11, libxkbcommon, libsecret, fuse2
# (for AppImage self-mount), libxss (screen saver detection).
PKG_ELECTRON_DEPS[apt-get]="libxkbcommon0 libsecret-1-0 fuse libnss3 libxss1 libasound2"
PKG_ELECTRON_DEPS[dnf]="libxkbcommon libsecret fuse nss libXScrnSaver alsa-lib"
PKG_ELECTRON_DEPS[pacman]="libxkbcommon libsecret fuse2 nss libxss alsa-lib"
PKG_ELECTRON_DEPS[zypper]="libxkbcommon0 libsecret-1-0 fuse mozilla-nss libXScrnSaver libasound2"
PKG_ELECTRON_DEPS[apk]="libxkbcommon libsecret fuse nss libxscrnsaver alsa-lib"

pm_install() {
  local pkgs="$*"
  case "$PM" in
    apt-get) $SUDO apt-get update -qq && $SUDO apt-get install -y $pkgs ;;
    dnf)     $SUDO dnf install -y $pkgs ;;
    pacman)  $SUDO pacman -Sy --noconfirm --needed $pkgs ;;
    zypper)  $SUDO zypper --non-interactive install $pkgs ;;
    apk)     $SUDO apk add --no-cache $pkgs ;;
  esac
}

# ── 2. Paste tooling (display-server-aware) ───────────────────────────────
#
# X11: xdotool handles key injection and wmctrl handles window
# activation/raising. Wayland: xdotool/wmctrl only work for XWayland
# windows, while wtype/ydotool cover native Wayland compositors.
# We therefore install the full compatible set for the detected session
# so runtime focus + paste flows match macOS semantics as closely as
# Linux allows.
print_step "Detecting display server..."
DISPLAY_SERVER="unknown"
if [ -n "${WAYLAND_DISPLAY:-}" ]; then
  DISPLAY_SERVER="wayland"
elif [ -n "${DISPLAY:-}" ]; then
  DISPLAY_SERVER="x11"
fi
HAS_X11_COMPAT=0
if [ -n "${DISPLAY:-}" ]; then
  HAS_X11_COMPAT=1
fi
print_ok "Display server: $DISPLAY_SERVER"

PASTE_PKGS=""
case "$DISPLAY_SERVER" in
  x11)
    case "$PM" in
      apt-get|dnf|zypper) PASTE_PKGS="xdotool wmctrl" ;;
      pacman)             PASTE_PKGS="xdotool wmctrl" ;;
      apk)                PASTE_PKGS="xdotool wmctrl" ;;
    esac
    ;;
  wayland)
    case "$PM" in
      apt-get) PASTE_PKGS="wtype ydotool" ;;
      dnf)     PASTE_PKGS="wtype ydotool" ;;
      pacman)  PASTE_PKGS="wtype ydotool" ;;
      zypper)  PASTE_PKGS="wtype ydotool" ;;
      apk)     PASTE_PKGS="wtype" ;;  # ydotool may not be in alpine
    esac
    if [ "$HAS_X11_COMPAT" -eq 1 ]; then
      PASTE_PKGS="$PASTE_PKGS xdotool wmctrl"
    fi
    ;;
  *)
    # Headless / unknown — install X11 tooling as least-common-denominator;
    # user can plug in a keyboard-driver later.
    PASTE_PKGS="xdotool wmctrl"
    ;;
esac

# ── 3. System dependencies ────────────────────────────────────────────────
print_step "Installing system dependencies..."
DEPS="${PKG_PYTHON[$PM]} ${PKG_NODE[$PM]} ${PKG_FFMPEG[$PM]} ${PKG_BUILD[$PM]} ${PKG_ELECTRON_DEPS[$PM]} $PASTE_PKGS"
echo "  Installing: $DEPS"
pm_install $DEPS
print_ok "System deps installed"

# ── 4. Python venv ────────────────────────────────────────────────────────
#
# ``XDG_DATA_HOME`` defaults to ~/.local/share per the XDG basedir
# spec. Electron's ``app.getPath("userData")`` on Linux resolves to
# ~/.config/transcriptor — we keep venv co-located with userData
# (Electron's TRANSCRIPTOR_DATA_DIR override) so both the packaged
# app and dev-launch use the same interpreter and installed wheels.
print_step "Creating Python venv..."
DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/transcriptor"
APP_VENV="$DATA_DIR/.venv"
mkdir -p "$DATA_DIR"

if [ -x "$APP_VENV/bin/python3" ] && "$APP_VENV/bin/python3" -c "import sys" 2>/dev/null; then
  print_ok "Venv already present: $APP_VENV"
else
  rm -rf "$APP_VENV"
  python3 -m venv "$APP_VENV"
  print_ok "Venv created: $APP_VENV"
fi

"$APP_VENV/bin/pip" install --upgrade pip --quiet
"$APP_VENV/bin/pip" install -r "$ROOT_DIR/requirements.txt" --quiet
if "$APP_VENV/bin/python3" -c "import fastapi, uvicorn, cryptography" 2>/dev/null; then
  print_ok "Python packages installed and verified"
else
  print_fail "Python deps installed but critical imports failed"
fi

# ── 5. Frontend + desktop npm deps ────────────────────────────────────────
print_step "Installing frontend npm deps..."
(cd "$ROOT_DIR/frontend" && npm install --silent 2>&1 | tail -2)
print_ok "Frontend deps installed"

print_step "Installing desktop npm deps..."
(cd "$ROOT_DIR/desktop" && npm install --silent 2>&1 | tail -2)
print_ok "Desktop deps installed"

# ── 6. Build frontend ─────────────────────────────────────────────────────
print_step "Building frontend..."
(cd "$ROOT_DIR/frontend" && npm run build 2>&1 | tail -5)
print_ok "Frontend built"

# ── 7. Build AppImage ─────────────────────────────────────────────────────
#
# electron-builder on Linux drops an AppImage into desktop/dist/. We
# then copy it to ~/.local/bin/Transcriptor.AppImage (XDG path for
# user-local executables) and chmod +x so it runs on double-click
# from a file manager.
print_step "Building AppImage..."
rm -rf "$ROOT_DIR/desktop/dist/linux-unpacked" 2>/dev/null || true
rm -f  "$ROOT_DIR/desktop/dist/"*.AppImage 2>/dev/null || true
(cd "$ROOT_DIR/desktop" && npm run dist:linux 2>&1 | tail -10)
APPIMAGE="$(ls "$ROOT_DIR/desktop/dist/"*.AppImage 2>/dev/null | head -1 || true)"
if [ -z "$APPIMAGE" ] || [ ! -f "$APPIMAGE" ]; then
  print_fail "AppImage not produced — check build output above"
fi
print_ok "AppImage built: $(basename "$APPIMAGE")"

# ── 8. Install to ~/.local/bin + create .desktop entry ────────────────────
print_step "Installing AppImage..."
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/Transcriptor.AppImage"
cp "$APPIMAGE" "$TARGET"
chmod +x "$TARGET"
print_ok "Installed: $TARGET"

# freedesktop .desktop file — appears in application menu automatically
# after next login or ``update-desktop-database``.
print_step "Creating application-menu entry..."
DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"
DESKTOP_FILE="$DESKTOP_DIR/Transcriptor.desktop"
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Transcriptor
GenericName=Voice Transcription
Comment=Voice-to-text transcription with auto-paste
Exec=$TARGET %U
Icon=$TARGET
Terminal=false
Categories=AudioVideo;Audio;Utility;
StartupWMClass=Transcriptor
DESKTOP
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
fi
print_ok ".desktop entry: $DESKTOP_FILE"

# Warn if ~/.local/bin isn't on PATH — common on fresh installs.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) print_warn "~/.local/bin is not on PATH — add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to ~/.profile or ~/.bashrc." ;;
esac

# ── 9. Clean up build artifacts ──────────────────────────────────────────
print_step "Cleaning build artifacts..."
rm -rf "$ROOT_DIR/desktop/dist/linux-unpacked" 2>/dev/null || true
rm -f  "$ROOT_DIR/desktop/dist/"*.AppImage.blockmap 2>/dev/null || true
print_ok "Cleaned"

# ── Done ──────────────────────────────────────────────────────────────────
echo
printf "${GREEN}${BOLD}  ╔══════════════════════════════════════════╗${NC}\n"
printf "${GREEN}${BOLD}  ║     ✔ Setup complete!                    ║${NC}\n"
printf "${GREEN}${BOLD}  ╚══════════════════════════════════════════╝${NC}\n"
echo
echo  "  ${BOLD}Launching Transcriptor...${NC}"
# Detach so the terminal returns. ``setsid`` decouples the process
# group so closing the terminal doesn't SIGHUP the app.
setsid nohup "$TARGET" </dev/null >/dev/null 2>&1 &
echo
echo  "  ${BOLD}Also available:${NC}"
echo  "    * Application menu → Transcriptor"
echo  "    * Terminal: Transcriptor.AppImage"
echo
echo  "  ${BOLD}First-time permissions:${NC}"
echo  "    * Microphone access — allow on first record"
if [ "$DISPLAY_SERVER" = "wayland" ]; then
  echo  "    * Wayland paste: if ydotool requires setup:"
  echo  "        sudo usermod -aG input \$USER  # then log out/in"
fi
echo
