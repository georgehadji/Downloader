#!/bin/sh
# yoinks installer for macOS and Linux:
#   curl -fsSL https://raw.githubusercontent.com/georgehadji/Downloader/main/install.sh | sh
# Clones the repo to ~/.yoinks/app, builds it, and links a `yoinks` command.
# Re-run it to update. Windows: use `npm install` + `npm link` (see README).
set -eu

REPO="${YOINKS_REPO:-https://github.com/georgehadji/Downloader.git}"
DIR="${YOINKS_HOME:-$HOME/.yoinks}/app"
BIN="${YOINKS_BIN:-$HOME/.local/bin}"

fail() {
  echo "yoinks: $1" >&2
  exit 1
}

for tool in git node npm; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found"
done

major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || fail "Node 22 or newer is required (found $(node -v))"

if [ -d "$DIR/.git" ]; then
  echo "updating yoinks…"
  git -C "$DIR" pull --ff-only --quiet
else
  echo "downloading yoinks…"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --quiet "$REPO" "$DIR"
fi

cd "$DIR"
echo "building…"
npm ci --silent
npm run build --silent

mkdir -p "$BIN"
chmod +x "$DIR/dist/cli.js"
ln -sf "$DIR/dist/cli.js" "$BIN/yoinks"
echo "installed: $BIN/yoinks"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "note: $BIN is not on your PATH — add it to your shell profile" ;;
esac
