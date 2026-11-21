#!/usr/bin/env bash
# Installs Power Glance for the current user.
set -euo pipefail

UUID="power-glance@local"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp "$SRC"/metadata.json "$SRC"/extension.js "$SRC"/sensors.js "$SRC"/stylesheet.css "$DEST"/
echo "Installed to $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled. If you were updating it, log out and back in to load the new version."
else
    echo "Log out and back in, then run: gnome-extensions enable $UUID"
fi
