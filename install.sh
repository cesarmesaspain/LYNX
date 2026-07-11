#!/usr/bin/env bash
#
# LYNX Installer — one-command install via curl | bash
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/LYNX/install.sh | bash
#
# Detects OS/arch, downloads the latest LYNX binary from GitHub Releases,
# verifies it, and installs to /usr/local/bin.
#
# Options:
#   INSTALL_DIR=/custom/path  — install to a different directory
#   LYNX_VERSION=v0.1.0     — install a specific version

set -euo pipefail

# ── Configuration ────────────────────────────────────────────
REPO_OWNER="${LYNX_REPO_OWNER:-mentesia}"
REPO_NAME="${LYNX_REPO_NAME:-mentesia-website}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="lynx"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}→${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
err()   { echo -e "${RED}✗${NC} $*" >&2; }

# ── Detect platform ──────────────────────────────────────────
detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)      err "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)             err "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# ── Determine version ────────────────────────────────────────
get_version() {
  if [ -n "${LYNX_VERSION:-}" ]; then
    echo "${LYNX_VERSION}"
    return
  fi

  # Fetch latest release tag
  local api="https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases"
  local tag
  tag=$(curl -fsSL "${api}" 2>/dev/null | grep -m1 '"tag_name":' | grep 'lynx-v' | sed -E 's/.*"([^"]+)".*/\1/')
  if [ -z "$tag" ]; then
    err "No LYNX release found. Set LYNX_VERSION manually."
    exit 1
  fi
  echo "$tag"
}

# ── Download and install ─────────────────────────────────────
main() {
  local platform version download_url binary_name dest

  platform=$(detect_platform)
  version=$(get_version)
  binary_name="${BINARY_NAME}-${platform}"
  dest="${INSTALL_DIR}/${BINARY_NAME}"

  info "Platform: ${platform}"
  info "Version:  ${version}"

  # GitHub release download URL
  download_url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${version}/${binary_name}"

  # Create temp directory
  local tmpdir
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT

  info "Downloading ${download_url}..."
  if ! curl -fsSL "${download_url}" -o "${tmpdir}/${BINARY_NAME}"; then
    err "Failed to download LYNX binary."
    err "URL: ${download_url}"
    exit 1
  fi

  # Make executable
  chmod +x "${tmpdir}/${BINARY_NAME}"

  # Quick smoke test
  info "Verifying binary..."
  if ! "${tmpdir}/${BINARY_NAME}" 2>&1 | grep -q "Commands:"; then
    err "Binary verification failed."
    exit 1
  fi

  # Install
  if [ ! -d "${INSTALL_DIR}" ]; then
    mkdir -p "${INSTALL_DIR}"
  fi

  if [ -w "${INSTALL_DIR}" ]; then
    mv "${tmpdir}/${BINARY_NAME}" "${dest}"
  else
    info "Need sudo to install to ${INSTALL_DIR}"
    sudo mv "${tmpdir}/${BINARY_NAME}" "${dest}"
  fi

  ok "LYNX ${version} installed to ${dest}"

  # Check PATH
  if ! command -v lynx >/dev/null 2>&1; then
    if [ -f "${dest}" ]; then
      info "Note: ${INSTALL_DIR} may not be in your PATH."
      info "Add it or use: ${dest}"
    fi
  else
    ok "lynx is in your PATH"
  fi

  echo ""
  info "Try it: lynx detect /path/to/your/project"
}

main
