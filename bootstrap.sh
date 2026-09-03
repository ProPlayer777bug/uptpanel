#!/usr/bin/env bash
# UptimeHost bootstrap — one-liner installer for fresh Linux / macOS VPS-VDS.
#
# Usage (public repo, clone over HTTPS — no credentials needed):
#   curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh | bash
#
# Installs git + Node.js + npm (+ Go + Docker where applicable), clones the
# UptimeHost source, and opens the setup.py DevOps menu.

set -euo pipefail

REPO_URL="${UH_REPO_URL:-https://github.com/ProPlayer777bug/uptpanel.git}"
BRANCH="${UH_BRANCH:-main}"
DIR="${UH_INSTALL_DIR:-$HOME/uptimehost}"

say() { printf '\033[1;36m[UH]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[UH] error:\033[0m %s\n' "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

# --- git ---------------------------------------------------------------
if ! command_exists git; then
  say "Installing git..."
  if command_exists apt-get; then
    sudo apt-get update && sudo apt-get install -y git
  elif command_exists yum; then
    sudo yum install -y git
  elif command_exists dnf; then
    sudo dnf install -y git
  elif command_exists brew; then
    brew install git
  else
    fail "Install git manually, then re-run this script."
  fi
fi

# --- Node.js / npm -----------------------------------------------------
if ! command_exists node; then
  say "Installing Node.js 20 LTS + npm..."
  curl -fsSL https://nodejs.org/dist/v20.19.4/node-v20.19.4-linux-x64.tar.xz \
    -o /tmp/node.tar.xz
  sudo mkdir -p /usr/local/lib/nodejs
  sudo tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs
  export PATH="/usr/local/lib/nodejs/node-v20.19.4-linux-x64/bin:$PATH"
  sudo ln -sf /usr/local/lib/nodejs/node-v20.19.4-linux-x64/bin/node /usr/local/bin/node
  sudo ln -sf /usr/local/lib/nodejs/node-v20.19.4-linux-x64/bin/npm  /usr/local/bin/npm
  sudo ln -sf /usr/local/lib/nodejs/node-v20.19.4-linux-x64/bin/npx  /usr/local/bin/npx
fi
node -v; npm -v

# --- Go (needed to build the node agent) -------------------------------
if ! command_exists go; then
  say "Installing Go 1.22+..."
  if command_exists apt-get; then
    sudo apt-get install -y golang-go || true
  elif command_exists brew; then
    brew install go
  fi
  if ! command_exists go; then
    say "Go not installed via package manager — you can still run panel/requirements,"
    say "and build the agent later with:  sudo apt install golang-go"
  fi
fi

# --- Docker (needed for containers) ------------------------------------
if ! command_exists docker; then
  say "Installing Docker (Community Edition)..."
  curl -fsSL https://get.docker.com | sh || say "Docker install failed — install it manually, the panel will still run."
fi

# --- Clone ------------------------------------------------------------------
# Non-interactive: never prompt for a username/password. If the repo is not
# publicly cloneable this will fail fast instead of hanging on a login prompt.
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
if [ ! -d "$DIR/.git" ]; then
  say "Cloning $REPO_URL -> $DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR"
else
  say "Updating existing clone at $DIR"
  (cd "$DIR" && git pull --ff-only)
fi

say "Running setup.py — pick an option (1 install panel, 2 install node, ...)"
cd "$DIR"
if [ -f setup.py ]; then
  python3 setup.py
else
  fail "setup.py not found in repo; ensure it is committed to GitHub."
fi
