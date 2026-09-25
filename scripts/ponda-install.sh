#!/bin/sh
# ponda installer — downloads the single-file bundle from GitHub Releases.
# Usage: curl -fsSL https://raw.githubusercontent.com/zenkoton/ponda/main/scripts/ponda-install.sh | sh
#   PONDA_VERSION=x.y.z   install a specific release (default: latest)
#   PONDA_BINDIR=dir      install directory (default: ~/.local/bin, created if missing)
# Requires: curl, sha256sum, Node >= 22 on PATH.
set -eu

REPO="zenkoton/ponda"
VERSION="${PONDA_VERSION:-latest}"
BINDIR="${PONDA_BINDIR:-$HOME/.local/bin}"

fail() { echo "ponda install failed: $*" >&2; exit 1; }

command -v curl > /dev/null 2>&1 || fail "curl not found"
command -v sha256sum > /dev/null 2>&1 || command -v shasum > /dev/null 2>&1 || fail "sha256sum not found"
command -v node > /dev/null 2>&1 || fail "node not found (ponda requires Node >= 22)"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || fail "node >= 22 required (found $(node --version))"

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$VERSION" ] || fail "could not resolve latest release"
fi

mkdir -p "$BINDIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BASE="https://github.com/${REPO}/releases/download/${VERSION}"
echo "==> downloading ponda ${VERSION}"
curl -fsSL -o "$TMP/ponda.mjs" "${BASE}/ponda.mjs" || fail "download ponda.mjs"
curl -fsSL -o "$TMP/SHA256SUMS" "${BASE}/SHA256SUMS" || true

if [ -s "$TMP/SHA256SUMS" ]; then
  expected="$(sed -n 's/^\([0-9a-f]\{64\}\)  ponda.mjs$/\1/p' "$TMP/SHA256SUMS")"
  if [ -n "$expected" ]; then
    actual="$(cd "$TMP" && (sha256sum ponda.mjs 2>/dev/null || shasum -a 256 ponda.mjs) | cut -d' ' -f1)"
    [ "$actual" = "$expected" ] || fail "checksum mismatch"
    echo "==> checksum ok"
  fi
fi

install_target="$BINDIR/ponda.mjs"
mv "$TMP/ponda.mjs" "$install_target"
# 免扩展名 wrapper：`ponda` 命令经 exec node 执行（Node >= 22）
printf '#!/bin/sh\nexec node "%s/ponda.mjs" "$@"\n' "$BINDIR" > "$BINDIR/ponda"
chmod +x "$BINDIR/ponda"

echo "==> installed: $BINDIR/ponda (v${VERSION#ponda-})"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "    note: $BINDIR is not on PATH" ;;
esac
"$BINDIR/ponda" --version
