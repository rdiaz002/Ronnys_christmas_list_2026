"""List Editor: a local page for editing gifts.json without touching JSON.

    tools/editor/run.sh      → http://localhost:8082

Standard library only, no setup needed. Saves go straight to gifts.json (the previous
version is kept as gifts.json.bak); commit and push as usual to publish.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote

HERE = Path(__file__).resolve().parent
SITE = HERE.parent.parent
GIFTS = SITE / "gifts.json"
STATIC = HERE / "static"
HOST = os.environ.get("EDITOR_HOST", "127.0.0.1")
PORT = int(os.environ.get("EDITOR_PORT", "8082"))
SITE_URL = os.environ.get("SITE_URL", "http://localhost:8087/")
STUDIO_URL = os.environ.get("STUDIO_URL", "http://localhost:8081/")

PRIORITIES = {"high", "medium", "low"}
WRAPS = {"stripes", "dots", "stars", "plaid", "plain"}
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
FIELD_ORDER = ["name", "note", "price", "priority", "links", "color", "accent", "ribbon", "wrap",
               "model", "modelRotation", "image"]
IMAGE_TYPES = {b"\x89PNG": ".png", b"\xff\xd8\xff": ".jpg", b"RIFF": ".webp", b"GIF8": ".gif"}
MAX_UPLOAD = 15 * 1024 * 1024


class BadRequest(Exception):
    pass


def version_of(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()[:16]


def asset_path(value, folder: str) -> str | None:
    """Accept only plain relative paths inside models/ or photos/."""
    if not value:
        return None
    value = str(value).strip().lstrip("./")
    if not value.startswith(folder + "/") or ".." in value.split("/") or "\\" in value:
        raise BadRequest(f"'{value}' must be a file inside {folder}/")
    return value


def clean_gift(raw: dict, n: int) -> dict:
    if not isinstance(raw, dict):
        raise BadRequest(f"Gift #{n} isn't valid.")
    name = str(raw.get("name", "")).strip()
    if not name:
        raise BadRequest(f"Gift #{n} needs a name.")
    gift: dict = {"name": name[:120]}
    for key, limit in (("note", 600), ("price", 40)):
        value = str(raw.get(key) or "").strip()
        if value:
            gift[key] = value[:limit]
    gift["priority"] = raw.get("priority") if raw.get("priority") in PRIORITIES else "medium"

    links = []
    for link in raw.get("links") or []:
        url = str((link or {}).get("url", "")).strip()
        if not url:
            continue
        if urlparse(url).scheme not in ("http", "https"):
            raise BadRequest(f"“{name}”: links must start with http:// or https:// ({url})")
        entry = {"label": str(link.get("label") or "").strip()[:40], "url": url}
        if not entry["label"]:
            del entry["label"]
        links.append(entry)
    gift["links"] = links

    for key in ("color", "accent", "ribbon"):
        value = str(raw.get(key) or "").strip()
        if value:
            if not HEX.match(value):
                raise BadRequest(f"“{name}”: {key} must be a colour like #b3202a")
            gift[key] = value.lower()
    if raw.get("wrap") in WRAPS:
        gift["wrap"] = raw["wrap"]

    model = asset_path(raw.get("model"), "models")
    if model:
        gift["model"] = model
        rot = raw.get("modelRotation") or [0, 0, 0]
        try:
            rot = [int(round(float(x))) % 360 for x in rot][:3]
        except (TypeError, ValueError):
            rot = [0, 0, 0]
        if any(rot):
            gift["modelRotation"] = rot
    image = asset_path(raw.get("image"), "photos")
    if image:
        gift["image"] = image

    # Keep any fields this editor doesn't know about.
    for key, value in raw.items():
        if key not in FIELD_ORDER and not key.startswith("_"):
            gift[key] = value
    return gift


def clean_list(data) -> dict:
    if not isinstance(data, dict) or not isinstance(data.get("gifts"), list):
        raise BadRequest("The list is malformed.")
    out = {}
    for key in ("title", "subtitle"):
        value = str(data.get(key) or "").strip()
        if value:
            out[key] = value[:120]
    out["gifts"] = [clean_gift(g, i + 1) for i, g in enumerate(data["gifts"])]
    for key, value in data.items():
        if key not in ("title", "subtitle", "gifts"):
            out[key] = value
    return out


def list_assets() -> dict:
    def files(folder, exts):
        d = SITE / folder
        return sorted(f"{folder}/{p.name}" for p in d.iterdir() if p.is_file() and p.suffix.lower() in exts) if d.is_dir() else []

    return {
        "models": files("models", {".glb", ".gltf"}),
        "photos": files("photos", {".png", ".jpg", ".jpeg", ".webp", ".gif"}),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "ListEditor/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if not self.path.startswith("/api/") or self.command != "GET":
            super().log_message(fmt, *args)

    # ------------------------------------------------------------ helpers
    def send_json(self, body, status=HTTPStatus.OK):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_file(self, path: Path):
        if not path.is_file():
            return self.send_error(HTTPStatus.NOT_FOUND)
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix == ".glb":
            ctype = "model/gltf-binary"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def read_body(self, limit=2 * 1024 * 1024) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            raise BadRequest("That file is too big.")
        return self.rfile.read(length)

    # ------------------------------------------------------------ routes
    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/":
            return self.send_file(STATIC / "index.html")
        if path.startswith("/static/"):
            target = (STATIC / path[len("/static/"):]).resolve()
            return self.send_file(target) if target.is_relative_to(STATIC) else self.send_error(HTTPStatus.NOT_FOUND)
        if path.startswith("/models/") or path.startswith("/photos/"):
            target = (SITE / path.lstrip("/")).resolve()
            return self.send_file(target) if target.is_relative_to(SITE) else self.send_error(HTTPStatus.NOT_FOUND)
        if path == "/api/list":
            raw = GIFTS.read_bytes()
            return self.send_json({"data": json.loads(raw), "version": version_of(raw)})
        if path == "/api/assets":
            return self.send_json(list_assets())
        if path == "/api/config":
            return self.send_json({"siteUrl": SITE_URL, "studioUrl": STUDIO_URL})
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):
        if urlparse(self.path).path != "/api/list":
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            body = json.loads(self.read_body() or b"{}")
            current = GIFTS.read_bytes()
            if body.get("version") != version_of(current):
                # Someone else (e.g. Gift Studio) saved since this page loaded.
                return self.send_json(
                    {"error": "The list changed on disk since you opened it.", "data": json.loads(current), "version": version_of(current)},
                    HTTPStatus.CONFLICT,
                )
            cleaned = clean_list(body.get("data"))
            raw = (json.dumps(cleaned, indent=2, ensure_ascii=False) + "\n").encode()
            shutil.copy(GIFTS, GIFTS.with_suffix(".json.bak"))
            tmp = GIFTS.with_suffix(".json.tmp")
            tmp.write_bytes(raw)
            tmp.replace(GIFTS)
            self.send_json({"data": cleaned, "version": version_of(raw)})
        except BadRequest as err:
            self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)
        except json.JSONDecodeError:
            self.send_json({"error": "Couldn't read that request."}, HTTPStatus.BAD_REQUEST)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/photos":
            return self.send_error(HTTPStatus.NOT_FOUND)
        try:
            data = self.read_body(MAX_UPLOAD)
            ext = next((e for magic, e in IMAGE_TYPES.items() if data.startswith(magic)), None)
            if not ext or (ext == ".webp" and data[8:12] != b"WEBP"):
                raise BadRequest("Use a PNG, JPG, WebP or GIF image.")
            base = re.sub(r"[^a-z0-9]+", "-", (parse_qs(url.query).get("name") or ["photo"])[0].lower()).strip("-")[:60] or "photo"
            photos = SITE / "photos"
            photos.mkdir(exist_ok=True)
            name, n = f"{base}{ext}", 2
            while (photos / name).exists():
                name, n = f"{base}-{n}{ext}", n + 1
            (photos / name).write_bytes(data)
            self.send_json({"path": f"photos/{name}"}, HTTPStatus.CREATED)
        except BadRequest as err:
            self.send_json({"error": str(err)}, HTTPStatus.BAD_REQUEST)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"\n  📝 List Editor → http://localhost:{PORT}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
