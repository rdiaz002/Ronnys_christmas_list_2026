#!/usr/bin/env bash
# One-time setup for Gift Studio (CPU only, no GPU needed). Re-running it is safe.
set -euo pipefail
cd "$(dirname "$0")"

PY=${PYTHON:-python3}
TRIPOSR_COMMIT=107cefdc244c39106fa830359024f6a2f1c78871

"$PY" -c 'import sys; assert sys.version_info >= (3, 9), "Python 3.9+ needed"' \
  || { echo "Python 3.9 or newer is required."; exit 1; }
"$PY" -m venv --help >/dev/null 2>&1 \
  || { echo "Python's venv module is missing. On Ubuntu/Debian: sudo apt install python3-venv"; exit 1; }

echo "→ Creating virtual environment (.venv)"
[ -d .venv ] || "$PY" -m venv .venv
.venv/bin/pip install -q --upgrade pip wheel

echo "→ Installing PyTorch (CPU build, ~200 MB)"
.venv/bin/pip install -q torch==2.4.1 --index-url https://download.pytorch.org/whl/cpu

echo "→ Installing the other dependencies"
.venv/bin/pip install -q -r requirements.txt

echo "→ Fetching TripoSR"
if [ ! -d vendor/TripoSR/.git ]; then
  mkdir -p vendor
  git clone -q https://github.com/VAST-AI-Research/TripoSR.git vendor/TripoSR
fi
git -C vendor/TripoSR fetch -q origin "$TRIPOSR_COMMIT" 2>/dev/null || true
git -C vendor/TripoSR checkout -q "$TRIPOSR_COMMIT"

echo "→ Downloading model weights (~2 GB the first time)"
.venv/bin/python -c "from pipeline import GiftModeler; GiftModeler()"

if ! command -v npx >/dev/null; then
  echo
  echo "Note: Node.js isn't installed, so models won't be compressed (they'll be ~2-4 MB instead of <1 MB)."
  echo "      Optional: install Node.js 18+ to enable compression."
fi

echo
echo "✓ All set. Start the studio with: tools/studio/run.sh"
