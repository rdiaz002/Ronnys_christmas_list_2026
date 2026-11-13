"""Photo → 3D gift model, running entirely on the CPU.

background removal (rembg) → TripoSR → clean up + decimate → texture bake → .glb (→ optional compression)

Two pieces of TripoSR are replaced so nothing needs compiling and no OpenGL context is needed:
  * torchmcubes (a C++/CUDA extension) → scikit-image's marching cubes
  * the moderngl texture rasteriser   → a small numpy rasteriser

Usable as a library (GiftModeler) or from the command line:
    python pipeline.py photo.jpg --out out_dir
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
import types
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable, Optional

import numpy as np
import torch
from PIL import Image, ImageOps

HERE = Path(__file__).resolve().parent
TRIPOSR_DIR = HERE / "vendor" / "TripoSR"

Progress = Callable[[str, str], None]

# Background removers (rembg model names). BiRefNet keeps holes open (e.g. inside a headphone band)
# where u2net tends to fill them with background.
SEGMENTERS = ("birefnet-general-lite", "birefnet-general", "u2net")


@dataclass
class Settings:
    foreground_ratio: float = 0.85  # how much of the frame the object fills before modelling
    resolution: int = 256           # marching-cubes grid; higher = more detail, slower
    max_faces: int = 40000          # triangles kept after simplification
    texture_size: int = 1024        # baked texture is texture_size² pixels
    bake_texture: bool = True       # False = per-vertex colours (softer, smaller)
    compress: bool = True           # Draco/WebP via gltf-transform, if Node.js is installed
    segmenter: str = SEGMENTERS[0]  # background remover, see SEGMENTERS


def _install_mcubes_shim() -> None:
    """TripoSR imports the compiled `torchmcubes` package; provide a scikit-image stand-in."""
    if "torchmcubes" in sys.modules:
        return
    from skimage.measure import marching_cubes as sk_marching_cubes

    def marching_cubes(volume: torch.Tensor, threshold: float):
        vol = volume.detach().cpu().numpy().astype(np.float32)
        try:
            verts, faces, _, _ = sk_marching_cubes(vol, level=threshold)
        except (ValueError, RuntimeError) as err:
            raise RuntimeError("Couldn't find an object in the photo. Try a clearer photo or a lower foreground ratio.") from err
        # scikit-image returns (i, j, k) index order; torchmcubes returns (k, j, i), which TripoSR swaps back.
        verts = np.ascontiguousarray(verts[:, ::-1])
        return torch.from_numpy(verts).float(), torch.from_numpy(faces.astype(np.int64))

    shim = types.ModuleType("torchmcubes")
    shim.marching_cubes = marching_cubes
    sys.modules["torchmcubes"] = shim


def _clean_cutout(img: Image.Image) -> Image.Image:
    """Tidy the background remover's mask: drop stray specks and harden smeared, half-transparent edges."""
    from skimage.measure import label
    from skimage.morphology import binary_dilation, disk

    rgba = np.array(img.convert("RGBA"))
    alpha = rgba[..., 3].astype(np.float32) / 255
    solid = alpha > 0.5
    if not solid.any():
        raise RuntimeError("Couldn't find an object in the photo. Try one with a plainer background.")
    labels = label(solid, connectivity=2)
    sizes = np.bincount(labels.ravel())
    sizes[0] = 0
    keep = np.isin(labels, np.flatnonzero(sizes >= sizes.max() * 0.01))
    alpha = np.where(binary_dilation(keep, disk(3)), alpha, 0)
    alpha = np.clip((alpha - 0.25) / 0.5, 0, 1)
    rgba[..., 3] = (alpha * 255).astype(np.uint8)
    return Image.fromarray(rgba)


def _rasterize_positions(uvs: np.ndarray, faces: np.ndarray, verts: np.ndarray, size: int):
    """For every texel covered by a UV triangle, the 3D surface point it maps to.

    Row 0 is v=0 (OpenGL convention), matching TripoSR's own baker.
    """
    pos = np.zeros((size, size, 3), np.float32)
    mask = np.zeros((size, size), bool)
    tri_uv = uvs[faces].astype(np.float64) * size - 0.5  # texel centres sit on integer coordinates
    tri_p = verts[faces]
    lo = np.clip(np.floor(tri_uv.min(axis=1)).astype(int), 0, size - 1)
    hi = np.clip(np.ceil(tri_uv.max(axis=1)).astype(int), 0, size - 1)
    eps = 1e-6
    for t in range(len(faces)):
        (ax, ay), (bx, by), (cx, cy) = tri_uv[t]
        det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if abs(det) < 1e-12:
            continue
        xs, ys = np.meshgrid(np.arange(lo[t, 0], hi[t, 0] + 1), np.arange(lo[t, 1], hi[t, 1] + 1))
        px, py = xs - ax, ys - ay
        w1 = (px * (cy - ay) - py * (cx - ax)) / det
        w2 = ((bx - ax) * py - (by - ay) * px) / det
        w0 = 1 - w1 - w2
        inside = (w0 >= -eps) & (w1 >= -eps) & (w2 >= -eps)
        if not inside.any():
            continue
        p0, p1, p2 = tri_p[t]
        w = np.stack([w0[inside], w1[inside], w2[inside]], axis=1)
        pos[ys[inside], xs[inside]] = w @ np.stack([p0, p1, p2])
        mask[ys[inside], xs[inside]] = True
    return pos, mask


def _dilate(colors: np.ndarray, mask: np.ndarray, iterations: int) -> np.ndarray:
    """Bleed colours past UV island edges so texture filtering doesn't pick up black seams."""
    out = colors.copy()
    filled = mask.copy()
    for _ in range(iterations):
        acc = np.zeros_like(out)
        cnt = np.zeros(mask.shape, np.float32)
        for shift in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            f = np.roll(filled, shift, axis=(0, 1))
            acc += np.roll(out, shift, axis=(0, 1)) * f[..., None]
            cnt += f
        grow = ~filled & (cnt > 0)
        out[grow] = acc[grow] / cnt[grow][:, None]
        filled |= grow
    return out


class GiftModeler:
    """Loads the models once; call make() for each photo."""

    def __init__(self, threads: Optional[int] = None, log: Callable[[str], None] = print):
        _install_mcubes_shim()
        if str(TRIPOSR_DIR) not in sys.path:
            sys.path.insert(0, str(TRIPOSR_DIR))
        from tsr.system import TSR

        if threads:
            torch.set_num_threads(threads)
        log("Loading TripoSR (first run downloads ~1.7 GB)…")
        self.model = TSR.from_pretrained("stabilityai/TripoSR", config_name="config.yaml", weight_name="model.ckpt")
        self.model.renderer.set_chunk_size(8192)
        self.model.to("cpu")
        self._segmenters = {}
        log("Loading background remover (first run downloads ~200 MB)…")
        self._segmenter(SEGMENTERS[0])
        log("Ready.")

    def _segmenter(self, name: str):
        """rembg sessions are loaded on first use and kept; a new one downloads its weights once."""
        name = name if name in SEGMENTERS else SEGMENTERS[0]
        if name not in self._segmenters:
            import onnxruntime as ort
            from rembg.sessions import sessions_class

            # BiRefNet briefly needs ~5.5 GB of scratch memory. ONNX Runtime's arena would keep all of it
            # reserved after the first photo; without the arena it's handed back as soon as the cut-out is done.
            opts = ort.SessionOptions()
            opts.enable_cpu_mem_arena = False
            opts.enable_mem_pattern = False
            session_class = next(c for c in sessions_class if c.name() == name)
            self._segmenters[name] = session_class(name, opts)
        return self._segmenters[name]

    def _query_colors(self, scene_code, points: np.ndarray) -> np.ndarray:
        with torch.no_grad():
            out = self.model.renderer.query_triplane(self.model.decoder, torch.from_numpy(points).float(), scene_code)
        return out["color"].cpu().numpy()

    def make(self, photo_path: Path, out_dir: Path, settings: Settings = Settings(), progress: Progress = lambda *_: None) -> dict:
        import trimesh
        import fast_simplification
        import xatlas
        import rembg
        from tsr.utils import resize_foreground

        out_dir.mkdir(parents=True, exist_ok=True)
        timings = {}
        clock = time.perf_counter()

        def lap(name):
            nonlocal clock
            now = time.perf_counter()
            timings[name] = round(now - clock, 1)
            clock = now

        # 1. Cut the object out of the photo.
        progress("cutout", "Removing the background")
        photo = ImageOps.exif_transpose(Image.open(photo_path))
        photo = photo.convert("RGBA" if "A" in photo.getbands() else "RGB")
        photo.thumbnail((1536, 1536))
        already_cut = photo.mode == "RGBA" and photo.getextrema()[3][0] < 255
        if not already_cut:
            photo = rembg.remove(photo, session=self._segmenter(settings.segmenter))
        cutout = resize_foreground(_clean_cutout(photo), settings.foreground_ratio)
        thumb = cutout.copy()
        thumb.thumbnail((600, 600))
        cutout_path = out_dir / "cutout.png"
        thumb.save(cutout_path, optimize=True)
        rgba = np.asarray(cutout).astype(np.float32) / 255.0
        rgb = rgba[..., :3] * rgba[..., 3:4] + (1 - rgba[..., 3:4]) * 0.5
        model_input = Image.fromarray((rgb * 255).astype(np.uint8))
        lap("cutout")

        # 2. Predict the 3D shape.
        progress("shape", "Imagining the 3D shape")
        with torch.no_grad():
            scene_codes = self.model([model_input], device="cpu")
        scene_code = scene_codes[0]
        lap("shape")

        # 3. Extract a mesh, drop floating specks, simplify.
        progress("mesh", "Building the mesh")
        mesh = self.model.extract_mesh(scene_codes, False, resolution=settings.resolution)[0]
        parts = mesh.split(only_watertight=False)
        if len(parts) > 1:
            biggest = max(len(p.faces) for p in parts)
            mesh = trimesh.util.concatenate([p for p in parts if len(p.faces) >= biggest * 0.02])
        raw_faces = len(mesh.faces)
        if raw_faces > settings.max_faces:
            v, f = fast_simplification.simplify(
                mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), target_reduction=1 - settings.max_faces / raw_faces,
            )
            mesh = trimesh.Trimesh(v, f, process=False)
        if mesh.volume < 0:  # make sure faces point outwards
            mesh.invert()
        lap("mesh")

        # 4. Colour it.
        if settings.bake_texture:
            progress("texture", "Painting the texture")
            size = settings.texture_size
            atlas = xatlas.Atlas()
            atlas.add_mesh(mesh.vertices, mesh.faces)
            pack = xatlas.PackOptions()
            pack.resolution = size
            pack.padding = max(2, size // 256)
            pack.bilinear = True
            atlas.generate(pack_options=pack)
            vmapping, indices, uvs = atlas[0]
            verts = mesh.vertices[vmapping]
            pos, mask = _rasterize_positions(uvs, indices, verts, size)
            colors = np.zeros((size, size, 3), np.float32)
            colors[mask] = self._query_colors(scene_code, pos[mask])
            colors = _dilate(colors, mask, pack.padding + 2)
            texture = Image.fromarray((np.clip(colors, 0, 1) * 255).astype(np.uint8)).transpose(Image.FLIP_TOP_BOTTOM)
            material = trimesh.visual.material.PBRMaterial(
                baseColorTexture=texture, metallicFactor=0.0, roughnessFactor=0.85, doubleSided=True,
            )
            mesh = trimesh.Trimesh(verts, indices, visual=trimesh.visual.TextureVisuals(uv=uvs, material=material), process=False)
        else:
            progress("texture", "Colouring the mesh")
            rgb = np.clip(self._query_colors(scene_code, mesh.vertices.astype(np.float32)), 0, 1)
            rgba = np.concatenate([rgb, np.ones((len(rgb), 1))], axis=1)
            mesh.visual = trimesh.visual.ColorVisuals(mesh, vertex_colors=(rgba * 255).astype(np.uint8))
        lap("texture")

        # TripoSR is Z-up with the input camera on +X. glTF is Y-up, and the site expects the front on +Z.
        mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
        mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [0, 1, 0]))

        model_path = out_dir / "model.glb"
        mesh.export(model_path, file_type="glb")
        raw_bytes = model_path.stat().st_size

        # 5. Optional compression.
        compressed = False
        if settings.compress and shutil.which("npx"):
            progress("compress", "Compressing")
            tmp = out_dir / "model.compressed.glb"
            cmd = ["npx", "-y", "@gltf-transform/cli@4.1.1", "optimize", str(model_path), str(tmp),
                   "--compress", "draco", "--texture-compress", "webp"]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
            if result.returncode == 0 and tmp.exists():
                tmp.replace(model_path)
                compressed = True
            else:
                progress("compress", "Compression failed; keeping the uncompressed model")
        lap("finish")

        return {
            "model": str(model_path),
            "cutout": str(cutout_path),
            "faces": int(len(mesh.faces)),
            "raw_faces": int(raw_faces),
            "textured": settings.bake_texture,
            "compressed": compressed,
            "bytes": model_path.stat().st_size,
            "raw_bytes": raw_bytes,
            "timings": timings,
            "settings": asdict(settings),
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Turn a photo into a .glb model on the CPU.")
    parser.add_argument("photo", type=Path)
    parser.add_argument("--out", type=Path, default=Path("out"))
    parser.add_argument("--foreground-ratio", type=float, default=Settings.foreground_ratio)
    parser.add_argument("--resolution", type=int, default=Settings.resolution)
    parser.add_argument("--max-faces", type=int, default=Settings.max_faces)
    parser.add_argument("--texture-size", type=int, default=Settings.texture_size)
    parser.add_argument("--vertex-colors", action="store_true", help="skip texture baking")
    parser.add_argument("--no-compress", action="store_true")
    parser.add_argument("--segmenter", choices=SEGMENTERS, default=SEGMENTERS[0])
    args = parser.parse_args()
    settings = Settings(args.foreground_ratio, args.resolution, args.max_faces, args.texture_size,
                        not args.vertex_colors, not args.no_compress, args.segmenter)
    modeler = GiftModeler()
    result = modeler.make(args.photo, args.out, settings, progress=lambda stage, msg: print(f"[{stage}] {msg}"))
    print(result)


if __name__ == "__main__":
    main()
