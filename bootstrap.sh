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
if [ ! -f setup.py ]; then
  fail "setup.py not found in repo; ensure it is committed to GitHub."
fi

# A plain `curl ... | sudo bash` opens the interactive DevOps menu (option 1
# install panel, 2 node, 3/4 uninstall, 6 add admin, ... 12 configure domain/
# HTTPS). setup.py reads keypresses from /dev/tty, so the menu works even though
# stdin is the curl pipe. No credentials are ever embedded anywhere.
#
#   curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh | sudo bash
#
# To install fully headless in one shot (no interactive menu), opt in explicitly:
#
#   curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh \
#     | sudo UH_OPT=1 bash
#
# Or install + expose on a domain with HTTPS in the same run:
#
#   curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh \
#     | sudo UH_PANEL_MODE=https UH_PANEL_DOMAIN=panel.example.com UH_ADMIN_AUTO=auto \
#           UH_OPEN_FIREWALL=yes bash
#
# Optional vars (all non-secret):
#   UH_OPT=<n>                  run a numbered setup.py option headless (default shows menu)
#   UH_PANEL_MODE   http|https  provoke unattended install (default: interactive menu)
#   UH_PANEL_DOMAIN             the panel domain (triggers DNS + Let's Encrypt)
#   UH_PUBLIC_IP                force the public IPv4 (else auto-detected)
#   UH_CF_TOKEN / UH_CF_ZONE_ID auto-create the A record via Cloudflare DNS
#   UH_CF_PROXIED               true/false for the Cloudflare proxy
#   UH_OPEN_FIREWALL            yes to open 80/443/API/node-agent ports
#   UH_ADMIN_AUTO=auto          generate a random admin password (recommended)
#   UH_ADMIN_PASSWORD           set the admin password explicitly
#   UH_ADMIN_EMAIL              admin login email
#   UH_UFW_ENABLE               yes to also run `ufw enable`
if [ "${UH_OPT:-}" = "menu" ]; then
  UH_OPT=""
  python3 setup.py "$@"
elif [ -n "${UH_OPT:-}" ]; then
  python3 setup.py "${UH_OPT}" "$@"
elif [ -n "${UH_PANEL_MODE:-}" ] || [ -n "${UH_ADMIN_AUTO:-}" ] || [ -n "${UH_ADMIN_PASSWORD:-}" ]; then
  say "Unattended mode — running full panel install."
  # Pass the option as a positional argument (robust, no env-propagation quirk);
  # other UH_* vars still flow through the environment for setup.py to read.
  python3 setup.py 1 "$@"
else
  say "Opening the setup menu (interactive) — pick a numbered option."
  python3 setup.py "$@"
fi
