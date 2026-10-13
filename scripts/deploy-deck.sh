#!/usr/bin/env bash
# Package Deck Curfew and install it on a Steam Deck over SSH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

HOST="${1:-deck@steamdeck.local}"
PLUGIN_NAME="DeckCurfew"
REMOTE_PLUGIN_DIR="~/homebrew/plugins/${PLUGIN_NAME}"
VERSION="$(node -p "require('./package.json').version")"
ZIP_PATH="${ROOT}/out/DeckCurfew-v${VERSION}.zip"

if [[ ! -f "${ZIP_PATH}" ]]; then
  echo "==> Packaging v${VERSION}"
  bash "${ROOT}/scripts/package.sh"
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 "${HOST}" 'echo ok' >/dev/null 2>&1; then
  if [[ "${HOST}" == "deck@steamdeck.local" ]]; then
    HOST="deck@192.168.0.193"
    echo "==> Falling back to ${HOST}"
  fi
  ssh -o BatchMode=yes -o ConnectTimeout=8 "${HOST}" 'echo ok' >/dev/null
fi

echo "==> Deploying DeckCurfew v${VERSION} → ${HOST}:${REMOTE_PLUGIN_DIR}"
scp -q "${ZIP_PATH}" "${HOST}:/tmp/DeckCurfew-update.zip"

ssh "${HOST}" "PLUGIN_NAME='${PLUGIN_NAME}' REMOTE_PLUGIN_DIR='${REMOTE_PLUGIN_DIR}'" bash -s <<'REMOTE'
set -euo pipefail
PLUGIN_DIR="${REMOTE_PLUGIN_DIR/#\~/$HOME}"
TMP="/tmp/DeckCurfew-deploy-$$"
rm -rf "${TMP}"
mkdir -p "${TMP}"
python3 - <<PY
import zipfile
from pathlib import Path
zf = zipfile.ZipFile("/tmp/DeckCurfew-update.zip")
zf.extractall("${TMP}")
PY

SRC="${TMP}/${PLUGIN_NAME}"
if [[ ! -f "${SRC}/plugin.json" ]]; then
  echo "error: ZIP missing ${PLUGIN_NAME}/plugin.json" >&2
  exit 1
fi

mkdir -p "$(dirname "${PLUGIN_DIR}")"
# Preserve settings outside the plugin tree (Decky settings dir)
rm -rf "${PLUGIN_DIR}"
mkdir -p "${PLUGIN_DIR}"
cp -a "${SRC}/." "${PLUGIN_DIR}/"
rm -rf "${TMP}" /tmp/DeckCurfew-update.zip

# Restart plugin loader so the new backend loads
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user restart plugin_loader.service 2>/dev/null; then
    echo "Restarted plugin_loader (user)"
  elif echo deck | sudo -S systemctl restart plugin_loader.service 2>/dev/null; then
    echo "Restarted plugin_loader (sudo)"
  else
    echo "Installed files; restart Decky manually if needed"
  fi
fi

python3 - <<PY
import json
from pathlib import Path
pkg = Path("${PLUGIN_DIR}") / "package.json"
print("Installed:", json.loads(pkg.read_text())["version"])
PY
REMOTE

echo "Done."
