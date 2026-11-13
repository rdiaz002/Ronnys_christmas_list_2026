#!/usr/bin/env bash
# Start the List Editor on http://localhost:8082 (override with EDITOR_PORT=...).
# Only needs Python 3.9+, no setup.
set -euo pipefail
cd "$(dirname "$0")"
exec python3 server.py
