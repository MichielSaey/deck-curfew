#!/usr/bin/env bash
# Build Deck Curfew and produce a Decky-installable ZIP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Prefer local pnpm if global isn't on PATH
export PATH="${HOME}/.npm-packages/bin:${PATH}"

PLUGIN_DIR_NAME="DeckCurfew"
VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="${ROOT}/out"
STAGE="${OUT_DIR}/stage/${PLUGIN_DIR_NAME}"
ZIP_NAME="DeckCurfew-v${VERSION}.zip"
ZIP_PATH="${OUT_DIR}/${ZIP_NAME}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm not found. Install pnpm 9 or add it to PATH." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 not found." >&2
  exit 1
fi

echo "==> Installing deps (if needed)"
pnpm i --frozen-lockfile

echo "==> Building frontend"
pnpm run build

if [[ ! -f dist/index.js ]]; then
  echo "error: dist/index.js missing after build" >&2
  exit 1
fi

echo "==> Staging plugin files"
rm -rf "${OUT_DIR}/stage"
mkdir -p "${STAGE}/dist" "${STAGE}/py_modules"

cp -a dist/index.js "${STAGE}/dist/"
# Source map optional for field debugging; keep zip smaller by default
if [[ "${INCLUDE_SOURCEMAP:-0}" == "1" ]] && [[ -f dist/index.js.map ]]; then
  cp -a dist/index.js.map "${STAGE}/dist/"
fi

cp -a main.py plugin.json package.json LICENSE README.md "${STAGE}/"
cp -a py_modules/curfew_schedule.py "${STAGE}/py_modules/"

if [[ -d assets ]]; then
  mkdir -p "${STAGE}/assets"
  find assets -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.svg' -o -name '*.gif' \) \
    -exec cp -a {} "${STAGE}/assets/" \; 2>/dev/null || true
fi

# Only ship defaults/ when it contains real plugin defaults (skip template placeholder).
if [[ -d defaults ]]; then
  mapfile -t default_files < <(find defaults -type f ! -name '.gitkeep' ! -name 'defaults.txt' 2>/dev/null || true)
  if ((${#default_files[@]})); then
    mkdir -p "${STAGE}/defaults"
    cp -a "${default_files[@]}" "${STAGE}/defaults/" 2>/dev/null || cp -a defaults/. "${STAGE}/defaults/"
  fi
fi

echo "==> Creating ${ZIP_NAME}"
mkdir -p "${OUT_DIR}"
rm -f "${ZIP_PATH}"

python3 - "${OUT_DIR}/stage" "${ZIP_PATH}" <<'PY'
import sys
import zipfile
from pathlib import Path

# stage_root contains DeckCurfew/ — zip entries must be DeckCurfew/...
stage_root = Path(sys.argv[1])
zip_path = Path(sys.argv[2])

count = 0
with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
    for path in sorted(stage_root.rglob("*")):
        if path.is_file():
            zf.write(path, path.relative_to(stage_root).as_posix())
            count += 1
print(f"packed {count} files")
PY

# Re-open to list (zipfile closed above)
python3 - "${ZIP_PATH}" <<'PY'
import sys
import zipfile
from pathlib import Path

zip_path = Path(sys.argv[1])
with zipfile.ZipFile(zip_path) as zf:
    print(f"Archive: {zip_path.name}")
    for name in zf.namelist():
        info = zf.getinfo(name)
        print(f"  {info.file_size:8d}  {name}")
PY

echo
echo "Done: ${ZIP_PATH}"
echo
echo "Install on Deck:"
echo "  1. Copy the ZIP to the Deck"
echo "  2. Decky → Developer → Install Plugin from ZIP"
echo "  3. Reload Decky if the plugin does not appear"
ls -lh "${ZIP_PATH}"
