"""Check GitHub Releases and install Deck Curfew updates."""

from __future__ import annotations

import json
import logging
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("deck-curfew")

GITHUB_REPO = "MichielSaey/deck-curfew"
RELEASES_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
USER_AGENT = "DeckCurfew-Updater"


def read_installed_version(plugin_dir: Path) -> str:
    pkg = plugin_dir / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        return str(data.get("version", "0.0.0"))
    except Exception:
        return "0.0.0"


def parse_version(value: str) -> tuple[int, ...]:
    cleaned = value.strip().lstrip("vV")
    parts: list[int] = []
    for piece in cleaned.split("."):
        num = ""
        for ch in piece:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def is_newer(latest: str, current: str) -> bool:
    return parse_version(latest) > parse_version(current)


def _http_json(url: str) -> Any:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_download(url: str, dest: Path) -> None:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/octet-stream",
            "User-Agent": USER_AGENT,
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)


def check_latest_release(current_version: str) -> dict[str, Any]:
    """
    Returns update metadata.
    {
      current, latest, updateAvailable, downloadUrl, releaseUrl, name, body
    }
    """
    result: dict[str, Any] = {
        "current": current_version,
        "latest": current_version,
        "updateAvailable": False,
        "downloadUrl": None,
        "releaseUrl": None,
        "name": None,
        "body": None,
        "error": None,
    }
    try:
        release = _http_json(RELEASES_URL)
    except urllib.error.HTTPError as exc:
        # 404 = no releases yet
        result["error"] = f"GitHub HTTP {exc.code}"
        return result
    except Exception as exc:
        result["error"] = str(exc)
        return result

    tag = str(release.get("tag_name") or "").lstrip("vV")
    result["latest"] = tag or current_version
    result["releaseUrl"] = release.get("html_url")
    result["name"] = release.get("name")
    result["body"] = release.get("body")
    result["updateAvailable"] = bool(tag) and is_newer(tag, current_version)

    assets = release.get("assets") or []
    preferred = f"DeckCurfew-v{tag}.zip"
    download_url: Optional[str] = None
    for asset in assets:
        name = asset.get("name") or ""
        url = asset.get("browser_download_url")
        if name == preferred and url:
            download_url = url
            break
    if not download_url:
        for asset in assets:
            name = asset.get("name") or ""
            url = asset.get("browser_download_url")
            if name.endswith(".zip") and "DeckCurfew" in name and url:
                download_url = url
                break
    result["downloadUrl"] = download_url
    if result["updateAvailable"] and not download_url:
        result["error"] = "Release found but no DeckCurfew ZIP asset"
        result["updateAvailable"] = False
    return result


def install_from_zip_url(download_url: str, plugin_dir: Path) -> dict[str, Any]:
    """Download a release ZIP and replace plugin files in plugin_dir."""
    plugin_dir = plugin_dir.resolve()
    if not plugin_dir.is_dir():
        raise RuntimeError(f"Plugin dir missing: {plugin_dir}")

    with tempfile.TemporaryDirectory(prefix="deck-curfew-update-") as tmp:
        tmp_path = Path(tmp)
        zip_path = tmp_path / "update.zip"
        extract_dir = tmp_path / "extract"
        extract_dir.mkdir()
        logger.info("Downloading update from %s", download_url)
        _http_download(download_url, zip_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

        # Expect DeckCurfew/… at archive root
        source = extract_dir / "DeckCurfew"
        if not source.is_dir():
            # fallback: first directory containing plugin.json
            candidates = [p for p in extract_dir.iterdir() if p.is_dir()]
            source = next((p for p in candidates if (p / "plugin.json").is_file()), None)
            if source is None:
                raise RuntimeError("ZIP did not contain a DeckCurfew plugin folder")

        required = ["plugin.json", "package.json", "main.py", "dist/index.js"]
        for rel in required:
            if not (source / rel).exists():
                raise RuntimeError(f"Update ZIP missing required file: {rel}")

        # Replace tree carefully: copy new files over, remove stale py modules not present
        for path in source.rglob("*"):
            if path.is_file():
                rel = path.relative_to(source)
                dest = plugin_dir / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, dest)

        # Drop leftover .pyc caches
        for pyc in plugin_dir.rglob("__pycache__"):
            shutil.rmtree(pyc, ignore_errors=True)

        new_version = read_installed_version(plugin_dir)
        logger.info("Installed update files for version %s", new_version)
        return {"installedVersion": new_version, "ok": True}
