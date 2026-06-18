#!/usr/bin/env bash
# ============================================================================
#  prepare-runtime.sh — download & assemble a bundled Python runtime for one
#  platform of the Transcriptor app.
#
#  Output: desktop/runtime/<platform>/ containing
#    - python/           (standalone cpython install; bin/python3 or python.exe)
#    - ffmpeg/bin/ffmpeg (static binary, where available)
#
#  Usage:  prepare-runtime.sh win-x64
#          prepare-runtime.sh mac-arm64
#          prepare-runtime.sh linux-x64
#          prepare-runtime.sh all
#
#  The script runs on the release host (macOS in our case) and uses
#  pip's cross-platform install (``--platform`` + ``--only-binary=:all:``)
#  to download Windows/Linux wheels onto the Mac without executing them.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPT_DIR="$(pwd)"
ROOT_DIR="$(cd .. && pwd)"
REQS="${ROOT_DIR}/requirements.txt"
REQS_LOCK="${ROOT_DIR}/requirements.runtime-lock.txt"
RUNTIME_DIR="${SCRIPT_DIR}/runtime"
CACHE_DIR="${SCRIPT_DIR}/runtime/.cache"
mkdir -p "${RUNTIME_DIR}" "${CACHE_DIR}"

# python-build-standalone tag (pinned so release builds are reproducible).
PBS_TAG="20260414"
PBS_PYVER="3.12.13"

# ffmpeg sources.
FFMPEG_WIN_RELEASE="autobuild-2026-06-18-14-21"
FFMPEG_WIN_ASSET="ffmpeg-N-125093-gd2d371d10d-win64-gpl.zip"
FFMPEG_WIN_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_WIN_RELEASE}/${FFMPEG_WIN_ASSET}"
FFMPEG_WIN_SHA256="90582d696445953f154beac0f73180961fe8c079db1c50238f9f28b5f84dfc1c"
# macOS packaged runtime support is arm64-only. Intel packaging was
# dropped before 1.1.25 and cannot use the current wheel-only runtime
# graph because cryptography 49.0.0 publishes macOS arm64 wheels only.
FFMPEG_MAC_ARM64_URL="https://www.osxexperts.net/ffmpeg71arm.zip"
FFMPEG_MAC_ARM64_SHA256="0878f3313311c2c1b2c818e7c955c0bd828c97b357fa86211b42a5c36d01e36f"
FFMPEG_LINUX_ASSET="ffmpeg-7.0.2-amd64-static.tar.xz"
FFMPEG_LINUX_URL="https://johnvansickle.com/ffmpeg/releases/${FFMPEG_LINUX_ASSET}"
FFMPEG_LINUX_SHA256="abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"

log()  { printf '\033[1;36m[prep]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[prep]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[prep]\033[0m %s\n' "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Download a file to CACHE_DIR once; reuse on subsequent runs.
# -----------------------------------------------------------------------------
fetch() {
  local url="$1" dest="$2"
  local sha256="${3:-}"
  local meta="${dest}.url"
  local sha_meta="${dest}.sha256"
  [ -n "${sha256}" ] || die "missing SHA256 for ${dest##*/}"
  if [ -f "${dest}" ] && [ -s "${dest}" ] && [ -f "${meta}" ] && [ "$(cat "${meta}")" = "${url}" ]; then
    if [ "$(sha256_file "${dest}")" = "${sha256}" ]; then
      printf '%s\n' "${sha256}" > "${sha_meta}"
      log "cached  ${dest##*/}"
      return 0
    fi
    warn "cached ${dest##*/} failed checksum or metadata validation; refetching"
    rm -f "${dest}" "${meta}" "${sha_meta}"
  fi
  log "fetching ${url}"
  curl -fSL --retry 3 --retry-delay 2 -o "${dest}.part" "${url}"
  verify_sha256 "${dest}.part" "${sha256}"
  printf '%s\n' "${url}" > "${meta}.part"
  printf '%s\n' "${sha256}" > "${sha_meta}.part"
  mv "${dest}.part" "${dest}"
  mv "${meta}.part" "${meta}"
  mv "${sha_meta}.part" "${sha_meta}"
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
    return
  fi
  die "missing sha256 tool: install shasum or sha256sum"
}

verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(sha256_file "${file}")"
  if [ "${actual}" != "${expected}" ]; then
    rm -f "${file}"
    die "checksum mismatch for ${file##*/}: expected ${expected}, got ${actual}"
  fi
}

python_sha256_for_triple() {
  local triple="$1"
  case "${triple}" in
    aarch64-apple-darwin)
      printf '%s\n' "38f71c324ae14ee5ef844c62e06b6faa5ba3040c898b4c1d03b8b6e88794356b"
      ;;
    x86_64-pc-windows-msvc)
      printf '%s\n' "d785d2e901a8194dcdb8c23c2b37a46ed84fdc04e87398dc5b832644330de71e"
      ;;
    x86_64-unknown-linux-gnu)
      printf '%s\n' "3c3427e5628648478da2aa227472c350475a68bc58109f1b43849636a4aecb89"
      ;;
    *)
      die "missing python-build-standalone SHA256 for ${triple}"
      ;;
  esac
}

# -----------------------------------------------------------------------------
# Download + extract python-build-standalone for the target triple.
#   $1 = runtime platform dir (e.g. runtime/win-x64)
#   $2 = triple (e.g. x86_64-pc-windows-msvc)
# -----------------------------------------------------------------------------
install_python() {
  local out_dir="$1" triple="$2"
  local tarball="cpython-${PBS_PYVER}+${PBS_TAG}-${triple}-install_only_stripped.tar.gz"
  local url="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_TAG}/${tarball}"
  local cached="${CACHE_DIR}/${tarball}"
  fetch "${url}" "${cached}" "$(python_sha256_for_triple "${triple}")"
  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"
  log "extracting python for ${triple}"
  # The tarball already contains a top-level "python/" directory with the
  # full runtime layout (python.exe + Lib/ on Windows, bin/python3 + lib/
  # on Unix). Extract as-is so the final path is out_dir/python/...
  tar -xzf "${cached}" -C "${out_dir}"
  [ -d "${out_dir}/python" ] || die "expected ${out_dir}/python after extract"
}

# -----------------------------------------------------------------------------
# Install all requirements.txt wheels into the bundled Python's site-packages
# via cross-platform pip download + install-to-target. Falls back to running
# the bundled Python's own pip when we're on that native platform.
# -----------------------------------------------------------------------------
install_wheels() {
  local out_dir="$1" python_tag="${2:-cp312}"
  shift 2
  # All remaining args are --platform values that pip will union.
  local target_dir
  if [ -d "${out_dir}/python/Lib/site-packages" ]; then
    target_dir="${out_dir}/python/Lib/site-packages"
  elif [ -d "${out_dir}/python/lib/python3.12/site-packages" ]; then
    target_dir="${out_dir}/python/lib/python3.12/site-packages"
  else
    die "could not find site-packages in ${out_dir}/python"
  fi

  log "installing wheels into ${target_dir#${ROOT_DIR}/}"

  # Multiple --platform flags allowed: pip takes the union of compatible
  # wheels across all tags. Needed because one dep may ship
  # manylinux_2_28 wheels (onnxruntime) while another ships only
  # manylinux_2_17 / manylinux2014 (tokenizers). Without the union,
  # picking --platform manylinux_2_28_x86_64 alone loses the older-
  # tagged wheels.
  local pip_args=(
    --disable-pip-version-check
    --no-compile
    --only-binary=:all:
    --python-version 3.12
    --implementation cp
    --abi "${python_tag}"
    --target "${target_dir}"
    --timeout 180
    --retries 5
  )
  [ -f "${REQS_LOCK}" ] || die "missing runtime constraints lock: ${REQS_LOCK}"
  pip_args+=(-c "${REQS_LOCK}")
  for p in "$@"; do
    pip_args+=(--platform "${p}")
  done
  pip_args+=(-r "${REQS}")

  python3 -m pip install "${pip_args[@]}"
}

# -----------------------------------------------------------------------------
# Install ffmpeg into out_dir/ffmpeg/bin/ffmpeg(.exe)
# -----------------------------------------------------------------------------
install_ffmpeg_win() {
  local out_dir="$1"
  local zip="${CACHE_DIR}/ffmpeg-win64.zip"
  fetch "${FFMPEG_WIN_URL}" "${zip}" "${FFMPEG_WIN_SHA256}"
  rm -rf "${out_dir}/ffmpeg"
  mkdir -p "${out_dir}/ffmpeg/bin"
  # Extract only ffmpeg.exe from the archive.
  local tmp
  tmp="$(mktemp -d)"
  unzip -q "${zip}" -d "${tmp}"
  find "${tmp}" -name "ffmpeg.exe" -exec cp {} "${out_dir}/ffmpeg/bin/ffmpeg.exe" \;
  rm -rf "${tmp}"
  [ -f "${out_dir}/ffmpeg/bin/ffmpeg.exe" ] || die "ffmpeg.exe not found in archive"
  log "ffmpeg.exe installed"
}

install_ffmpeg_mac() {
  local out_dir="$1" arch="$2"
  local url cache_name sha256
  if [ "${arch}" = "arm64" ]; then
    url="${FFMPEG_MAC_ARM64_URL}"
    cache_name="ffmpeg-mac-arm64.zip"
    sha256="${FFMPEG_MAC_ARM64_SHA256}"
  else
    die "macOS bundled runtime is arm64-only; unsupported arch: ${arch}"
  fi
  local zip="${CACHE_DIR}/${cache_name}"
  fetch "${url}" "${zip}" "${sha256}"
  rm -rf "${out_dir}/ffmpeg"
  mkdir -p "${out_dir}/ffmpeg/bin"
  # osxexperts arm zip contains __MACOSX/ metadata junk; extract only
  # the actual ffmpeg binary and discard the rest.
  local tmp
  tmp="$(mktemp -d)"
  unzip -q -o "${zip}" -d "${tmp}"
  # Prefer a top-level "ffmpeg" file; fall back to any "ffmpeg" in the tree.
  if [ -f "${tmp}/ffmpeg" ]; then
    cp "${tmp}/ffmpeg" "${out_dir}/ffmpeg/bin/ffmpeg"
  else
    local found=""
    while IFS= read -r -d '' f; do
      found="$f"
      break
    done < <(find "${tmp}" -name "ffmpeg" -type f -not -path "*/__MACOSX/*" -print0)
    [ -n "${found}" ] || die "ffmpeg binary not found in archive"
    cp "${found}" "${out_dir}/ffmpeg/bin/ffmpeg"
  fi
  rm -rf "${tmp}"
  chmod +x "${out_dir}/ffmpeg/bin/ffmpeg"
  [ -x "${out_dir}/ffmpeg/bin/ffmpeg" ] || die "ffmpeg binary not executable"
  # Verify arch matches target to catch future URL regressions early.
  local actual_arch
  actual_arch="$(/usr/bin/file -b "${out_dir}/ffmpeg/bin/ffmpeg" | grep -oE '(arm64|x86_64)' | head -1)"
  if [ -n "${actual_arch}" ] && [ "${actual_arch}" != "${arch}" ]; then
    die "ffmpeg arch mismatch: expected ${arch}, got ${actual_arch} from ${url}"
  fi
  log "ffmpeg (mac/${arch}) installed"
}

install_ffmpeg_linux() {
  local out_dir="$1"
  local tar="${CACHE_DIR}/ffmpeg-linux.tar.xz"
  fetch "${FFMPEG_LINUX_URL}" "${tar}" "${FFMPEG_LINUX_SHA256}"
  rm -rf "${out_dir}/ffmpeg"
  mkdir -p "${out_dir}/ffmpeg/bin"
  local tmp
  tmp="$(mktemp -d)"
  tar -xJf "${tar}" -C "${tmp}"
  # `find -executable` is GNU-only; portable check is `-perm -u+x`.
  # There may be multiple `ffmpeg` entries in the archive (nested
  # bin/ + symlinks); pick the largest one which is the real binary.
  local best=""
  local best_size=0
  while IFS= read -r -d '' f; do
    local sz
    sz=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f")
    if [ "$sz" -gt "$best_size" ]; then
      best="$f"
      best_size="$sz"
    fi
  done < <(find "${tmp}" -name "ffmpeg" -type f -perm -u+x -print0)
  [ -n "$best" ] || die "ffmpeg binary not found in linux archive"
  cp "$best" "${out_dir}/ffmpeg/bin/ffmpeg"
  rm -rf "${tmp}"
  chmod +x "${out_dir}/ffmpeg/bin/ffmpeg"
  log "ffmpeg (linux) installed"
}

# -----------------------------------------------------------------------------
# Platform recipes
# -----------------------------------------------------------------------------
build_win_x64() {
  local out_dir="${RUNTIME_DIR}/win-x64"
  log "=== Windows x64 ==="
  install_python "${out_dir}" "x86_64-pc-windows-msvc"
  install_wheels "${out_dir}" "cp312" "win_amd64"
  install_ffmpeg_win "${out_dir}"
  du -sh "${out_dir}" | awk '{print "size:", $1}'
}

build_mac_arm64() {
  local out_dir="${RUNTIME_DIR}/mac-arm64"
  log "=== macOS arm64 ==="
  install_python "${out_dir}" "aarch64-apple-darwin"
  # Floor macOS 11 for our own deps, but onnxruntime universal2 wheel
  # requires tag 13_0 — union both so pip can pick from either.
  install_wheels "${out_dir}" "cp312" \
    "macosx_13_0_arm64" "macosx_12_0_arm64" "macosx_11_0_arm64"
  install_ffmpeg_mac "${out_dir}" "arm64"
  du -sh "${out_dir}" | awk '{print "size:", $1}'
}

build_linux_x64() {
  local out_dir="${RUNTIME_DIR}/linux-x64"
  log "=== Linux x64 ==="
  install_python "${out_dir}" "x86_64-unknown-linux-gnu"
  # Union modern and legacy manylinux tags so onnxruntime (2_28),
  # tokenizers (2_17 / manylinux2014), and everyone else get a match.
  install_wheels "${out_dir}" "cp312" \
    "manylinux_2_28_x86_64" "manylinux_2_17_x86_64" "manylinux2014_x86_64"
  install_ffmpeg_linux "${out_dir}"
  du -sh "${out_dir}" | awk '{print "size:", $1}'
}

target="${1:-}"
case "${target}" in
  win-x64)    build_win_x64 ;;
  mac-arm64)  build_mac_arm64 ;;
  linux-x64)  build_linux_x64 ;;
  all)
    build_win_x64
    build_mac_arm64
    build_linux_x64
    ;;
  *)
    die "usage: $0 <win-x64|mac-arm64|linux-x64|all>"
    ;;
esac

log "done"
