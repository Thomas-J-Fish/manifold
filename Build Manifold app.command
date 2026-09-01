#!/bin/bash
# Double-click this file to build Manifold.app.
#
# It installs the dependencies, builds the app, wraps it in a macOS bundle and
# then launches that bundle once to check it works. The result is left in
# dist-app/Manifold.app, ready to drag into your Applications folder.
#
# Everything happens inside this folder. Nothing is installed system-wide and
# nothing is sent anywhere.

set -uo pipefail
cd "$(dirname "$0")" || exit 1

BOLD=$'\033[1m'
DIM=$'\033[2m'
GREEN=$'\033[32m'
RED=$'\033[31m'
RESET=$'\033[0m'

printf '%s\n' "${BOLD}Building Manifold${RESET}"
printf '%s\n\n' "${DIM}$(pwd)${RESET}"

fail() {
  printf '\n%s%s%s\n\n' "$RED" "$1" "$RESET"
  printf 'Press return to close this window.\n'
  read -r _
  exit 1
}

# ---------------------------------------------------------------- node

if ! command -v node >/dev/null 2>&1; then
  # A GUI double-click gets a login shell without the PATH additions that a
  # Terminal session picks up, so the usual install locations are checked by
  # hand before giving up.
  for candidate in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do
    if [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed.

Manifold needs Node to build. Install it from https://nodejs.org
(the LTS download is the right one), then double-click this file again."
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node $(node -v) is too old — Manifold needs Node 20 or newer.
Update it from https://nodejs.org and try again."
fi
printf 'Using Node %s\n' "$(node -v)"

# ---------------------------------------------------------------- install

if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
  printf '\n%s\n' "${BOLD}Installing dependencies…${RESET}"
  printf '%s\n' "${DIM}This takes a couple of minutes the first time.${RESET}"
  npm install --no-audit --no-fund || fail "npm install failed. Scroll up to see why."
else
  printf 'Dependencies are already installed.\n'
fi

# The electron package sometimes installs only its stub when a download is
# interrupted; that produces a baffling error much later, so it is checked here.
if [ ! -d node_modules/electron/dist ]; then
  printf '\n%s\n' "${BOLD}Finishing the Electron download…${RESET}"
  node node_modules/electron/install.js || fail "Could not download the Electron runtime."
fi

# ---------------------------------------------------------------- build

printf '\n%s\n' "${BOLD}Building…${RESET}"
npm run build || fail "The build failed. Scroll up to see why."

if [ ! -f build/manifold.icns ]; then
  printf '\n%s\n' "${BOLD}Drawing the icon…${RESET}"
  python3 build/make-icon.py || printf '%s\n' "${DIM}Could not draw the icon; using the one in the repository.${RESET}"
fi

printf '\n%s\n' "${BOLD}Wrapping it as a macOS app…${RESET}"
node tools/make-app.js || fail "Building the .app failed. Scroll up to see why."

# ---------------------------------------------------------------- done

APP="$(pwd)/dist-app/Manifold.app"
printf '\n%s%s%s\n' "$GREEN" "Done. Manifold.app is ready." "$RESET"
printf '%s\n\n' "${DIM}$APP${RESET}"
printf 'Opening the folder…\n'
open dist-app 2>/dev/null || true

printf '\nWould you like to launch it now? [Y/n] '
read -r answer
case "$answer" in
  [nN]*) ;;
  *) open "$APP" ;;
esac

printf '\nPress return to close this window.\n'
read -r _
