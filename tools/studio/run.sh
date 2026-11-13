#!/usr/bin/env bash
# Start Gift Studio on http://localhost:8081 (override with STUDIO_PORT=...).
set -euo pipefail
cd "$(dirname "$0")"
[ -x .venv/bin/python ] || { echo "Run tools/studio/setup.sh first."; exit 1; }
exec .venv/bin/python server.py
