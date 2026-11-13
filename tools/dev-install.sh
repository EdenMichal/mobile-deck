#!/usr/bin/env bash
# Installs this checkout into Foundry as a separate module, "mobile-deck-dev",
# so the stable "mobile-deck" used by real campaigns is never touched.
# Enable "Mobile Deck (DEV)" only in the test world, with "mobile-deck" disabled there.
# Re-run after every change, then reload the Foundry client.
#
# Foundry's user data folder defaults to the standard macOS path,
# "$HOME/Library/Application Support/FoundryVTT/Data". Set FOUNDRY_DATA to override it, e.g.
#   FOUNDRY_DATA="$HOME/.local/share/FoundryVTT/Data" tools/dev-install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${FOUNDRY_DATA:-$HOME/Library/Application Support/FoundryVTT/Data}"
DEST="$DATA/modules/mobile-deck-dev"

if [ ! -d "$DATA/modules" ]; then
  echo "No Foundry modules folder at: $DATA/modules" >&2
  echo "Set FOUNDRY_DATA to your Foundry user data folder (the one that holds modules/, systems/ and worlds/)." >&2
  exit 1
fi

mkdir -p "$DEST"
rsync -a --delete \
  --exclude .git --exclude .github --exclude .claude --exclude .impeccable --exclude .DS_Store --exclude docs --exclude tools --exclude tests --exclude '*.md' \
  "$SRC/" "$DEST/"

# Rewrite only the module id where a string starts with it: settings namespace
# and full keys ("mobile-deck.x"), flags, localStorage keys ("mobile-deck:x"), CSS
# settings selectors, and the socket channel ("module.mobile-deck").
# CSS class names (ve-*) never start with the id, so they are untouched.
LC_ALL=C find "$DEST/src" "$DEST/assets" -type f \( -name '*.mjs' -o -name '*.css' \) -print0 \
  | xargs -0 perl -pi -e 's/(["\x27`])mobile-deck(?=["\x27`.:])/$1mobile-deck-dev/g; s/(["\x27`])module\.mobile-deck(?=["\x27`])/$1module.mobile-deck-dev/g; s/flags\\\.mobile-deck\\\./flags\\.mobile-deck-dev\\./g'

python3 - "$DEST/module.json" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["id"] = "mobile-deck-dev"
d["title"] = "Mobile Deck (DEV)"
for k in ("manifest", "download"):
    d.pop(k, None)
json.dump(d, open(p, "w"), indent=2, ensure_ascii=False)
EOF

echo "Installed $DEST ($(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$DEST/module.json"))"
