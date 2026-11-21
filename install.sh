#!/usr/bin/env bash
# Installs Power Glance for the current user.
set -euo pipefail

UUID="power-glance@local"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

# Replace the old copy completely so removed files don't linger. History data lives elsewhere
# (~/.local/share/power-glance) and is kept.
rm -rf "$DEST"
mkdir -p "$DEST/ui"
cp "$SRC"/metadata.json "$SRC"/stylesheet.css "$DEST"/
cp "$SRC"/*.js "$DEST"/
cp "$SRC"/ui/*.js "$DEST"/ui/
# The Battery tab points here for the optional one-time charge-limit setup.
install -m 755 "$SRC"/setup-charge-limit.sh "$DEST"/
echo "Installed to $DEST"

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Enabled. If you were updating it, log out and back in to load the new version."
else
    echo "Log out and back in, then run: gnome-extensions enable $UUID"
fi
