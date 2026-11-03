#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$SCRIPT_DIR/preflight.py"
exec siphon -c "${SIPHON_CONFIG_FILE:-$SCRIPT_DIR/siphon.yaml.example}"
