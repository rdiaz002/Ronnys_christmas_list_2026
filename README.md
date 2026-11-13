# 🎄 My Christmas List

A 3D Christmas tree with my wish list underneath. Gifts with a 3D model sit unwrapped under the tree; the rest are still wrapped presents. Click any of them to see what it is and where to buy it. The tree grows as the list does, and gets snowier and more decorated as Christmas gets closer.

Plain static files (Three.js from a CDN), so it runs on GitHub Pages with no build step.

## Adding a gift

The easy way is the **List Editor**, a local page for adding, editing, reordering and deleting gifts:

```bash
tools/editor/run.sh          # → http://localhost:8082  (plain Python 3.9+, no setup)
```

It edits name, note, price, priority, links, wrapping colours, 3D model (with a live preview and rotate buttons) and photo (pick one or upload). Save with the button or Ctrl+S; the previous version is kept as `gifts.json.bak`. If Gift Studio saved something in the meantime, the editor notices and asks before overwriting. Then commit and push.

Or edit `gifts.json` by hand:

```json
{
  "name": "Noise-Cancelling Headphones",
  "note": "Over-ear, black or silver.",
  "price": "~$350",
  "priority": "high",
  "links": [
    { "label": "Amazon", "url": "https://..." },
    { "label": "Best Buy", "url": "https://..." }
  ],
  "model": "models/noise-cancelling-headphones.glb",
  "image": "photos/noise-cancelling-headphones.png"
}
```

| Field | Required | What it does |
|---|---|---|
| `name` | ✔ | Shown on the card, the list and the hover tooltip |
| `note` | | A line of detail (size, colour, why) |
| `price` | | Free text, e.g. `"~$50"` |
| `priority` | | `high` (bigger box + gold star, placed up front), `medium` (default), `low` |
| `links` | | Where to buy. `label` is optional and defaults to the site name |
| `model` | | A `.glb` shown unwrapped under the tree (see below). Without one, the gift is a wrapped present |
| `modelRotation` | | `[x, y, z]` in degrees, if a model comes out sideways |
| `image` | | A photo shown on the card, and revealed when a wrapped present is opened |
| `color`, `accent`, `ribbon` | | Wrapping paper / pattern / ribbon colours (hex). Random but stable if omitted |
| `wrap` | | `stripes`, `dots`, `stars`, `plaid` or `plain` |

Wrapped presents with no image reveal a golden star instead. If a model fails to load, that gift falls back to a wrapped present.

## The countdown to Christmas

The scene follows the calendar. On Nov 1 the tree is mostly bare with a few lights and a light flurry. Each day adds more lights, baubles and snow on the branches. Gold bead garlands go up from mid-November and red bows for the final stretch. By Christmas Eve it's fully decorated in heavy snow, and it stays that way until Jan 6.

Preview any day with a URL parameter:

- `?date=2026-12-20` shows the scene as it will look on that date
- `?festive=0.5` sets the level directly (0 = Nov 1, 1 = Christmas Eve)

## Time of day, the moon and reindeer

The sky follows the viewer's own clock: night, a pink dawn, blue winter daylight, an orange sunset and a deep-blue evening, blending smoothly between them. The lighting, fog, stars and shadows change with it. The moon hangs low beside the tree in its real phase for today's date. Every minute or so a small group of reindeer wanders across the snow behind the tree, sometimes stopping to graze.

Preview with URL parameters (they combine with the ones above):

- `?time=16:40` shows a given time of day
- `?moon=0.5` sets the moon phase (0 = new, 0.25 = first quarter, 0.5 = full)
- `?reindeer=now` sends the reindeer out straight away

## Turning a photo into a 3D model: Gift Studio

A local page at **http://localhost:8081** where you upload a photo, preview the 3D model and save it into the list. Runs on the CPU, no GPU needed (about 40 s per photo on a 16-core machine).

**One-time setup** (Linux/macOS, Python 3.9+, ~3 GB download):

```bash
tools/studio/setup.sh
```

On Ubuntu/Debian you may first need `sudo apt install python3-venv`. Node.js is optional: if it's installed, models get compressed to ~0.3 MB instead of ~2 MB.

**Each time:**

```bash
tools/studio/run.sh          # → http://localhost:8081
```

1. Pick an existing gift, or **New gift** and fill in its name, note, price, priority and links.
2. Drop in a photo.
3. **Make it 3D**, then spin the preview. If it's lying on its side, use the rotate buttons.
4. **Save to list**. This copies the model to `models/`, the cut-out photo to `photos/`, and updates `gifts.json`.
5. Check it under the tree on http://localhost:8087, then commit and push as usual.

Under the hood: background removal (rembg with BiRefNet, plus clean-up of stray specks and smeared edges) → [TripoSR](https://github.com/VAST-AI-Research/TripoSR) image-to-3D → mesh clean-up and simplification → texture bake (the photo itself is projected onto the parts of the model it shows, so those keep the photo's sharpness and true colours; TripoSR's own, blurrier colours fill in the sides and back) → optional Draco/WebP compression. TripoSR's compiled and OpenGL parts are swapped for pure-Python equivalents, so nothing needs compiling. There's also a command-line version: `tools/studio/.venv/bin/python tools/studio/pipeline.py photo.jpg --out somewhere/`.

Good photos make good models: one object, plain background, whole thing in frame, slightly from above. While it works, the studio shows the cut-out it is using. If background is left in it, switch **Settings → Background remover** to "Best". It's a single-photo guess at the back side, so expect "charming" rather than "photo-real".

**Alternative, no install:** `tools/photo_to_3d.ipynb` does the same on Google Colab's free GPU (File → Upload notebook, then Runtime → Change runtime type → T4 GPU).

## Preview locally

Browsers block `fetch()` from `file://`, so serve the folder:

```bash
python3 -m http.server 8087
# open http://localhost:8087
```

## Publishing on GitHub Pages

1. Create a repo and push this folder to `main`.
2. Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick `main` / `(root)`.
3. The site appears at `https://YOUR-USERNAME.github.io/YOUR-REPO/` within a minute or two. Each push updates it.

## Files

```
index.html        page shell + import map for Three.js
css/style.css     UI styling
js/main.js        renderer, camera, picking, glue
js/world.js       sky, sun, moon, snow, ground, forest, lighting
js/daytime.js     time-of-day sky colours and moon phase
js/reindeer.js    the wandering reindeer
js/tree.js        the tree (scales with the list, decorations follow the season)
js/season.js      how festive today is (Nov 1 → Christmas Eve)
js/gifts.js       presents, layout rings, unwrap animation, model loading
js/ui.js          card, list panel, countdown, tooltip
gifts.json        ← the list
models/, photos/  generated assets
tools/editor/             List Editor: local page for editing gifts.json (run.sh, server.py)
tools/studio/             Gift Studio: local photo → 3D page (setup.sh, run.sh, server.py, pipeline.py)
tools/photo_to_3d.ipynb   same pipeline on Google Colab
```
