#!/bin/bash
# Double-click this to run Manifold directly from the source, without building
# a .app bundle. Useful while editing the code; the Terminal window has to stay
# open while the app runs.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  printf '\nNode.js is not installed. Get it from https://nodejs.org and try again.\n\n'
  printf 'Press return to close this window.\n'
  read -r _
  exit 1
fi

[ -d node_modules ] || npm install --no-audit --no-fund
npm start

printf '\nManifold has closed. Press return to close this window.\n'
read -r _
