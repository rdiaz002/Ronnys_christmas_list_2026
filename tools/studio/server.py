"""Gift Studio: a local page for turning gift photos into 3D models for the Christmas list.

    ./run.sh          → http://localhost:8081

Upload a photo, preview the model, then "Save to list" copies it into models/ and photos/
and updates gifts.json. Commit and push as usual to publish.
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, request, send_from_directory
from PIL import Image

from pipeline import SEGMENTERS

HERE = Path(__file__).resolve().parent
SITE = HERE.parent.parent
GIFTS = SITE / "gifts.json"
WORK = HERE / "work"
HOST = os.environ.get("STUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("STUDIO_PORT", "8081"))
SITE_URL = os.environ.get("SITE_URL", "http://localhost:8087/")

PRIORITIES = {"high", "medium", "low"}
STAGES = ["cutout", "shape", "mesh", "texture", "compress"]

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024

model_state = {"status": "loading", "message": "Starting up…"}
jobs: dict[str, dict] = {}
job_queue: "queue.Queue[str]" = queue.Queue()
gifts_lock = threading.Lock()


# ---------------------------------------------------------------- worker

def worker() -> None:
    from pipeline import GiftModeler, Settings

    try:
        modeler = GiftModeler(log=lambda msg: model_state.update(message=msg))
        model_state.update(status="ready", message="Ready")
    except Exception as err:  # noqa: BLE001 - surface anything to the page
        traceback.print_exc()
        model_state.update(status="error", message=f"Couldn't load the model: {err}")
        return

    while True:
        job_id = job_queue.get()
        job = jobs[job_id]
        job.update(status="running", started=time.time())

        def progress(stage: str, message: str) -> None:
            job.update(stage=stage, message=message)
            job["log"].append(f"{time.time() - job['started']:6.1f}s  {message}")

        try:
            result = modeler.make(Path(job["photo"]), WORK / job_id, Settings(**job["settings"]), progress)
            job.update(status="done", stage="done", message="Done", result=result)
        except Exception as err:  # noqa: BLE001
            traceback.print_exc()
            job.update(status="error", message=str(err) or type(err).__name__)
        job["finished"] = time.time()


# ---------------------------------------------------------------- helpers

def read_gifts() -> dict:
    return json.loads(GIFTS.read_text(encoding="utf-8"))


def write_gifts(data: dict) -> None:
    tmp = GIFTS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(GIFTS)


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "gift"


def unique_slug(base: str, gift: dict, gifts: list[dict]) -> str:
    """A file name that doesn't clobber another gift's model."""
    taken = {g.get("model") for g in gifts if g is not gift}
    slug, n = base, 2
    while f"models/{slug}.glb" in taken:
        slug, n = f"{base}-{n}", n + 1
    return slug


def clean_links(links) -> list[dict]:
    out = []
    for link in links or []:
        url = str(link.get("url", "")).strip()
        if urlparse(url).scheme not in ("http", "https"):
            continue
        entry = {"label": str(link.get("label", "")).strip()[:40], "url": url}
        if not entry["label"]:
            del entry["label"]
        out.append(entry)
    return out


def parse_settings(raw: dict) -> dict:
    def pick(key, allowed, default):
        try:
            value = type(default)(raw.get(key, default))
        except (TypeError, ValueError):
            return default
        return value if value in allowed else default

    def clamp(key, lo, hi, default):
        try:
            return min(hi, max(lo, type(default)(raw.get(key, default))))
        except (TypeError, ValueError):
            return default

    return {
        "foreground_ratio": clamp("foreground_ratio", 0.5, 1.0, 0.85),
        "resolution": pick("resolution", {192, 256, 320}, 256),
        "max_faces": clamp("max_faces", 5000, 150000, 40000),
        "texture_size": pick("texture_size", {512, 1024, 2048}, 1024),
        "bake_texture": bool(raw.get("bake_texture", True)),
        "compress": bool(raw.get("compress", True)),
        "segmenter": raw.get("segmenter") if raw.get("segmenter") in SEGMENTERS else SEGMENTERS[0],
    }


def public_job(job_id: str) -> dict:
    job = jobs[job_id]
    out = {k: job.get(k) for k in ("status", "stage", "message", "log", "settings")}
    out["id"] = job_id
    out["stages"] = STAGES
    if job["status"] == "queued":
        out["queuePosition"] = list(job_queue.queue).index(job_id) + 1 if job_id in job_queue.queue else 1
    if (WORK / job_id / "cutout.png").exists():
        out["cutout"] = f"/work/{job_id}/cutout.png"
    if job.get("started"):
        out["elapsed"] = round((job.get("finished") or time.time()) - job["started"], 1)
    if job.get("result"):
        r = job["result"]
        out["result"] = {
            "model": f"/work/{job_id}/model.glb",
            "cutout": f"/work/{job_id}/cutout.png",
            **{k: r[k] for k in ("faces", "raw_faces", "bytes", "raw_bytes", "textured", "compressed", "timings")},
        }
    return out


def cleanup_old_work(max_age_hours: float = 48) -> None:
    if not WORK.exists():
        return
    cutoff = time.time() - max_age_hours * 3600
    for d in WORK.iterdir():
        if d.is_dir() and d.stat().st_mtime < cutoff:
            shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------- routes

@app.get("/")
def index():
    return send_from_directory(HERE / "static", "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(HERE / "static", name)


@app.get("/work/<job_id>/<name>")
def work_files(job_id, name):
    if job_id not in jobs or name not in ("model.glb", "cutout.png"):
        abort(404)
    return send_from_directory(WORK / job_id, name, max_age=0)


@app.get("/api/status")
def status():
    busy = sum(1 for j in jobs.values() if j["status"] in ("queued", "running"))
    return jsonify(model=model_state, siteUrl=SITE_URL, busy=busy)


@app.get("/api/gifts")
def gifts():
    data = read_gifts()
    return jsonify([
        {"index": i, "name": g.get("name", ""), "model": g.get("model"), "image": g.get("image"), "priority": g.get("priority", "medium")}
        for i, g in enumerate(data.get("gifts", []))
    ])


@app.post("/api/jobs")
def create_job():
    photo = request.files.get("photo")
    if not photo or not photo.filename:
        return jsonify(error="Pick a photo first."), 400
    job_id = uuid.uuid4().hex[:12]
    job_dir = WORK / job_id
    job_dir.mkdir(parents=True)
    ext = Path(photo.filename).suffix.lower()
    if ext not in (".jpg", ".jpeg", ".png", ".webp", ".heic", ".bmp"):
        ext = ".img"
    photo_path = job_dir / f"photo{ext}"
    photo.save(photo_path)
    try:
        with Image.open(photo_path) as im:
            im.verify()
    except Exception:  # noqa: BLE001
        shutil.rmtree(job_dir, ignore_errors=True)
        return jsonify(error="That file doesn't look like an image this tool can read (try JPG or PNG)."), 400
    settings = parse_settings(json.loads(request.form.get("settings") or "{}"))
    jobs[job_id] = {"status": "queued", "stage": None, "message": "Waiting in line…", "log": [], "photo": str(photo_path), "settings": settings}
    job_queue.put(job_id)
    return jsonify(public_job(job_id)), 201


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    if job_id not in jobs:
        abort(404)
    return jsonify(public_job(job_id))


@app.post("/api/jobs/<job_id>/save")
def save_job(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify(error="That model isn't ready yet."), 400
    body = request.get_json(force=True) or {}

    rotation = body.get("modelRotation") or [0, 0, 0]
    try:
        rotation = [int(round(float(x))) % 360 for x in rotation][:3]
    except (TypeError, ValueError):
        rotation = [0, 0, 0]

    with gifts_lock:
        data = read_gifts()
        gifts_list = data.setdefault("gifts", [])
        if body.get("index") is not None:
            try:
                gift = gifts_list[int(body["index"])]
            except (IndexError, ValueError, TypeError):
                return jsonify(error="That gift isn't in the list anymore. Reload the page."), 400
        else:
            new = body.get("new") or {}
            name = str(new.get("name", "")).strip()
            if not name:
                return jsonify(error="Give the new gift a name."), 400
            gift = {"name": name[:120]}
            for key in ("note", "price"):
                if str(new.get(key, "")).strip():
                    gift[key] = str(new[key]).strip()[:400]
            gift["priority"] = new.get("priority") if new.get("priority") in PRIORITIES else "medium"
            gift["links"] = clean_links(new.get("links"))
            gifts_list.append(gift)

        slug = unique_slug(slugify(gift["name"]), gift, gifts_list)
        (SITE / "models").mkdir(exist_ok=True)
        (SITE / "photos").mkdir(exist_ok=True)
        shutil.copy(WORK / job_id / "model.glb", SITE / "models" / f"{slug}.glb")
        gift["model"] = f"models/{slug}.glb"
        if any(rotation):
            gift["modelRotation"] = rotation
        else:
            gift.pop("modelRotation", None)
        if body.get("useCutout", True):
            shutil.copy(WORK / job_id / "cutout.png", SITE / "photos" / f"{slug}.png")
            gift["image"] = f"photos/{slug}.png"
        write_gifts(data)

    return jsonify(gift=gift, siteUrl=SITE_URL)


if __name__ == "__main__":
    cleanup_old_work()
    WORK.mkdir(exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    print(f"\n  🎁 Gift Studio → http://localhost:{PORT}\n")
    app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)
