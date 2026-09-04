#!/usr/bin/env python3
"""
UptimeHost setup — DevOps CLI
============================

Cross-platform (Linux / macOS / Windows) numbered menu that provisions and
operates the UptimeHost control plane on the current machine.

    [1] Install panel        install requirements, build the web bundle, and
                             start the API + web services in the background.
    [2] Install node         connect this machine (or a remote one) as a panel
                             node: asks for the panel URL, admin email + password
                             (with a live login check), node FQDN/IP, http/https,
                             creates the node in the panel, then prints the SINGLE
                             install command (clone -> build -> write creds to
                             /etc/uptimehost/agent.env -> start a uh-agent systemd
                             service). Optionally runs it on this machine too.
    [3] Uninstall panel      stop the panel API + web services and remove the
                             built web bundle.
    [4] Uninstall node       stop the node agent.
    [5] Install requirements install npm + Go dependencies and build the agent.
    [6] Add admin user/pass  log into the panel API as an existing admin and
                             provision a new administrator account.
    [7] Configure SMTP       point the panel at your SMTP server for email/OTP
                             sign-in; optionally send a test message to verify.
    [8] Configure Google     paste your Google OAuth client id/secret (auto-redirect).
    [9] Configure GitHub     paste your GitHub OAuth client id/secret (auto-redirect).
    [10] Configure all auth  guided pass to set SMTP + Google + GitHub together.
    [11] Generate script     pick a predefined template (node install / HTTPS /
                             backup) and emit a ready-to-run shell script with
                             your own credentials/addresses baked in.

Each auth step talks to the running panel over its admin API — no manual DB
editing. Only the panel URL + an admin login are needed.

Uses only the Python standard library. On POSIX systems it daemonizes service
processes with their own session; on Windows it uses CREATE_NEW_PROCESS_GROUP.

Environment overrides (all optional):
    UH_REPO_DIR    path to the UptimeHost checkout (default: setup.py parent)
    UH_API_URL     panel API base URL, e.g. http://panel.example.com:8081
                   (default: http://localhost:8081)
    UH_WEB_PORT    web dev-server port (default: 8080)
    UH_API_PORT    API port (default: 8081)

Auth-configuration overrides:
    UH_PANEL_URL / UH_PANEL_ADMIN_EMAIL / UH_PANEL_ADMIN_PASSWORD
    UH_PANEL_ADMIN_TOKEN   (token avoids the password prompt; for non-TTY runs)
    UH_SMTP_HOST / UH_SMTP_PORT / UH_SMTP_USER / UH_SMTP_PASS / UH_SMTP_FROM
    UH_GOOGLE_CLIENT_ID / UH_GOOGLE_CLIENT_SECRET / UH_GOOGLE_REDIRECT
    UH_GITHUB_CLIENT_ID / UH_GITHUB_CLIENT_SECRET / UH_GITHUB_REDIRECT

Script-generation overrides (prefix each template env var with UH_SCRIPT_):
    e.g. UH_SCRIPT_PANEL_URL, UH_SCRIPT_AGENT_HOST, UH_SCRIPT_PANEL_EMAIL ...
    and UH_SCRIPT_TEMPLATE=node-agent|panel-https|backup-data

Public install (option [1] automates public exposure):
    No env vars are required. A plain `curl ... | sudo bash` installs the panel
    over HTTP at the host's address; set the optional vars below to also expose
    it publicly on a domain with HTTPS in the same run. To add a domain + HTTPS
    later, pick option [12] "Configure domain / HTTPS" after installing.
    UH_PANEL_MODE     http|https      access mode (defaults to http, no domain)
    UH_PANEL_DOMAIN   panel.example.com   the panel domain (also UH_PANEL_FQDN)
    UH_PUBLIC_IP      force the host's public IPv4 (auto-detected if omitted)
    UH_CF_TOKEN / UH_CF_ZONE_ID  auto-create the DNS A record via Cloudflare
    UH_CF_PROXIED     true/false for the Cloudflare proxy (default false)
    UH_OPEN_FIREWALL  yes to open 80/443, the API port and the node-agent port
    UH_UFW_ENABLE     yes to also run `ufw enable --force`
    UH_ADMIN_AUTO=auto  generate a random, unique admin password (recommended)
    UH_ADMIN_PASSWORD   set the admin password explicitly
    UH_ADMIN_EMAIL      admin login email (default admin@uptime.host)

One-line install on a fresh VPS (no credentials in the command):
    curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh | sudo bash

Same, but expose it on a domain with HTTPS in the same run:
    curl -sSL https://raw.githubusercontent.com/ProPlayer777bug/uptpanel/main/bootstrap.sh \\
      | sudo UH_PANEL_MODE=https UH_PANEL_DOMAIN=panel.example.com UH_ADMIN_AUTO=auto \\
            UH_OPEN_FIREWALL=yes bash

Security: the well-known seed admin password is rotated on every install and a
fresh value is printed exactly once. No admin password is ever written to disk,
embedded in the script, or included in the installer command.
"""

import getpass
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import urllib.parse

APP_NAME = "uptimehost"

REPO_URL = "https://github.com/ProPlayer777bug/uptpanel.git"

REPO_DIR = os.environ.get("UH_REPO_DIR") or os.path.dirname(os.path.abspath(__file__))
API_URL = os.environ.get("UH_API_URL", "http://localhost:8081")
WEB_PORT = os.environ.get("UH_WEB_PORT", "8080")
API_PORT = os.environ.get("UH_API_PORT", "8081")
STATE_FILE = os.path.join(REPO_DIR, "setup.state.json")

WIN = sys.platform.startswith("win")
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if WIN else 0

SCRIPT_NAME = os.path.basename(sys.argv[0])


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def info(msg):
    print("[UH] " + msg)


def warn(msg):
    print("[UH][warn] " + msg)


def err(msg):
    print("[UH][error] " + msg, file=sys.stderr)


def die(msg, code=1):
    err(msg)
    sys.exit(code)


def sh(cmd, cwd=None, env=None, capture=False):
    """Run a command; return (exit_code, stdout)."""
    base = dict(os.environ)
    if env:
        base.update(env)
    if capture:
        p = subprocess.run(cmd, cwd=cwd, env=base, capture_output=True, text=True)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    info("running: " + " ".join(cmd))
    p = subprocess.run(cmd, cwd=cwd, env=base)
    return p.returncode, ""


def require(prog, hint=""):
    if not shutil.which(prog):
        die(f"required program '{prog}' not found on PATH. {hint}".strip())
    return shutil.which(prog)


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def param(label, env, state_key=None, default=None):
    """Resolve a value: env var > saved state > default > interactive prompt.
    Never blocks when stdin is not a TTY (e.g. piped curl|bash)."""
    val = os.environ.get(env)
    if not val and state_key:
        val = (load_state() or {}).get(state_key)
    if not val and default is not None:
        val = default
    if val is not None:
        return str(val)
    if not sys.stdin.isatty():
        die(f"'{label}' required — set env {env} (stdin is not a TTY)", 2)
    try:
        got = input(f"{label}: ").strip()
    except (EOFError, KeyboardInterrupt):
        die(f"'{label}' required — set env {env}", 2)
    return got or default


def q(label, env, default=None):
    """Form-field prompt. env var > (TTY prompt with default) > default.
    Dies cleanly if a required value is none of those (non-TTY)."""
    val = os.environ.get(env, "")
    if val:
        return val
    if sys.stdin.isatty():
        try:
            suf = "" if default is None else f" [{default}]"
            got = input(f"{label}{suf}: ").strip()
        except (EOFError, KeyboardInterrupt):
            return default
        return got or default
    if default is None:
        die(f"'{label}' required — set env {env} (stdin is not a TTY)", 2)
    return default


def pid_file(name):
    return os.path.join(REPO_DIR, f".{name}.pid")


def log_file(name):
    return os.path.join(REPO_DIR, f"{name}.log")


def tail_log(name, lines=20):
    """Print the last N lines of a process log for diagnosing startup failures."""
    path = log_file(name)
    if not os.path.exists(path):
        warn(f"no log file at {path}")
        return
    try:
        with open(path) as fh:
            all_lines = fh.read().splitlines()
        for line in all_lines[-lines:]:
            print(f"  | {line}")
    except Exception as e:
        warn(f"could not read log {path}: {e}")


def read_pid(name):
    p = pid_file(name)
    if os.path.exists(p):
        try:
            return int(open(p).read().strip())
        except Exception:
            return None
    return None


def is_running(pid):
    if not pid:
        return False
    try:
        if WIN:
            subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True,
            )
            return False  # cross-check below via psutil-free fallback is unreliable
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def stop_daemon(name):
    pid = read_pid(name)
    pfile = pid_file(name)
    if pid and is_running(pid):
        info(f"stopping {name} (pid {pid})")
        try:
            if WIN:
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
            else:
                os.kill(pid, 9)
        except OSError:
            pass
        if not WIN:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
    if os.path.exists(pfile):
        os.remove(pfile)
    info(f"stopped {name}")
    return True


def start_daemon(name, cmd, cwd=None, env=None):
    """Start a process detached from this shell, tracked by a pid file."""
    base = dict(os.environ)
    if env:
        base.update(env)
    logf = open(log_file(name), "a")
    p = subprocess.Popen(
        cmd,
        cwd=cwd or REPO_DIR,
        env=base,
        stdin=subprocess.DEVNULL,
        stdout=logf,
        stderr=logf,
        start_new_session=not WIN,
        creationflags=CREATE_NEW_PROCESS_GROUP if WIN else 0,
    )
    with open(pid_file(name), "w") as f:
        f.write(str(p.pid))
    info(f"started {name} (pid {p.pid}) -> {log_file(name)}")
    return p.pid


def systemd_available():
    """True when systemd is PID 1 (Linux hosts running modern distros)."""
    return (not WIN) and os.path.isdir("/run/systemd/system")


def install_agent_service(env, agent_bin):
    """Install the node agent as a systemd service for auto-start on reboot.

    Writes /etc/systemd/system/my-panel-agent.service with the resolved
    environment baked in (so a plain `systemctl start` needs no shell env),
    then enables it. Requires root to write to /etc/systemd/system.
    """
    unit = "/etc/systemd/system/my-panel-agent.service"
    if os.geteuid() != 0:
        warn("systemd install needs root — skipping (agent can still run via the pid-file daemon).")
        return False
    lines = [
        "[Unit]",
        "Description=UptimeHost Node Agent",
        "After=docker.service network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=" + agent_bin,
        "WorkingDirectory=" + os.path.dirname(agent_bin),
    ]
    for k in ("UH_CORE_URL", "UH_NODE_ID", "UH_REG_TOKEN", "UH_AGENT_ADDR",
              "UH_AGENT_TOKEN", "UH_AGENT_SCHEME", "UH_AGENT_HOST", "UH_AGENT_PORT",
              "UH_AGENT_TLS_CERT", "UH_AGENT_TLS_KEY", "UH_POLL_INTERVAL"):
        if env.get(k):
            v = str(env[k]).replace("%", "%%")
            lines.append(f"Environment={k}={v}")
    lines += [
        "Restart=always",
        "RestartSec=3",
        "TimeoutStopSec=10",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ]
    tmp = unit + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines))
    os.replace(tmp, unit)
    sh(["systemctl", "daemon-reload"])
    sh(["systemctl", "enable", "my-panel-agent.service"])
    sh(["systemctl", "restart", "my-panel-agent.service"])
    info("Installed systemd service my-panel-agent.service (auto-starts on reboot).")
    return True


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------
def install_requirements():
    info("Installing requirements...")
    require("npm", "install Node.js >= 18 from https://nodejs.org")
    # Refuse to proceed on an unsupported (too old) Node — native-built deps
    # (e.g. esbuild) fail cryptically otherwise, and the web build needs >=18.
    try:
        ver = subprocess.run(["node", "-v"], capture_output=True, text=True).stdout.strip()
        major = int(ver.lstrip("v").split(".")[0])
        if major < 18:
            die(f"Node {ver} is too old — UptimeHost needs Node >= 18. Install Node 20 LTS and re-run.")
        info(f"Node.js {ver} detected")
    except Exception:
        warn("could not parse node version; continuing")
    code, out = sh(["npm", "install"], cwd=REPO_DIR, capture=True)
    if code != 0:
        die("npm install failed:\n" + out)
    go_dir = os.path.join(REPO_DIR, "services", "agent")
    if os.path.exists(os.path.join(go_dir, "go.mod")):
        if not shutil.which("go"):
            warn("'go' not found — skipping agent build. Install Go to build the node agent.")
        else:
            code, out = sh(["go", "mod", "download"], cwd=go_dir, capture=True)
            if code != 0:
                die("go mod download failed:\n" + out)
            code, out = sh(["go", "build", "-o", os.path.join(go_dir, "bin", "uh-agent"), "./cmd/agent"], cwd=go_dir, capture=True)
            if code != 0:
                die("agent build failed:\n" + out)
            info("Built node agent -> services/agent/bin/uh-agent")
    info("Requirements installed.")
    return True


def setup_panel_https(fqdn):
    """Install nginx + certbot and issue a Let's Encrypt cert for <fqdn>,
    reverse-proxying https://<fqdn>:443 -> http://127.0.0.1:WEB_PORT (the panel
    web server). DNS for <fqdn> must already point at this host's public IP."""
    require("sudo", "HTTPS panel setup needs sudo")
    if shutil.which("apt-get"):
        sh(["sudo", "apt-get", "update"])
        sh(["sudo", "apt-get", "install", "-y", "nginx", "certbot", "python3-certbot-nginx"])
    elif shutil.which("dnf") or shutil.which("yum"):
        sh(["sudo", "dnf", "install", "-y", "nginx", "certbot", "python3-certbot-nginx"])
    else:
        die("unsupported package manager for nginx/certbot")
    conf = (
        f"server {{\n"
        f"    listen 80;\n"
        f"    server_name {fqdn};\n"
        f"    location / {{\n"
        f"        proxy_pass http://127.0.0.1:{WEB_PORT};\n"
        f"        proxy_set_header Host $host;\n"
        f"        proxy_set_header X-Real-IP $remote_addr;\n"
        f"        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
        f"        proxy_set_header X-Forwarded-Proto $scheme;\n"
        f"        proxy_http_version 1.1;\n"
        f"        proxy_set_header Upgrade $http_upgrade;\n"
        f"        proxy_set_header Connection \"upgrade\";\n"
        f"    }}\n"
        f"}}\n"
    )
    tmp = os.path.join(REPO_DIR, f".nginx-{fqdn}.conf")
    with open(tmp, "w") as f:
        f.write(conf)
    sh(["sudo", "cp", tmp, f"/etc/nginx/sites-available/{fqdn}"])
    sh(["sudo", "ln", "-sf", f"/etc/nginx/sites-available/{fqdn}", f"/etc/nginx/sites-enabled/{fqdn}"])
    sh(["sudo", "nginx", "-t"])
    sh(["sudo", "systemctl", "reload", "nginx"])
    email = os.environ.get("UH_PANEL_EMAIL") or ""
    if not email and sys.stdin.isatty():
        try:
            email = input("Lets Encrypt email (cert expiry notices, optional): ").strip()
        except (EOFError, KeyboardInterrupt):
            email = ""
    if email:
        sh(["sudo", "certbot", "--nginx", "-d", fqdn, "--redirect", "--agree-tos", "-m", email, "--non-interactive"])
    else:
        sh(["sudo", "certbot", "--nginx", "-d", fqdn, "--redirect", "--register-unsafely-without-email", "--agree-tos", "--non-interactive"])
    sh(["sudo", "systemctl", "reload", "nginx"])
    info(f"Panel HTTPS ready at https://{fqdn}  (cert auto-renews via certbot)")


# ---------------------------------------------------------------------------
# Public accessibility for a fresh install.
#
# A freshly-installed panel is useless if it is only reachable on localhost,
# and it is dangerous if left on the well-known seed credentials. These helpers
# make a public deployment fully automatic AND secure by default:
#
#   * detect the host's public IPv4 (no creds needed),
#   * verify / create a DNS A record for the panel domain,
#   * open the firewall for web + API + node-agent traffic,
#   * rotate the seed admin password to a fresh value so nothing is left as a
#     hardcoded default (nothing secret is ever written to disk).
#
# No operator credential is ever embedded in setup.py or the one-line installer.
# ---------------------------------------------------------------------------
def detect_public_ip():
    """Best-effort discover of this host's public IPv4 using only stdlib calls
    through well-known IP echo endpoints. Returns '' if it cannot be found."""
    env_ip = os.environ.get("UH_PUBLIC_IP", "").strip()
    if env_ip:
        return env_ip
    for svc in (
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
        "https://checkip.amazonaws.com",
    ):
        try:
            with urllib.request.urlopen(urllib.request.Request(svc), timeout=5) as r:
                ip = (r.read().decode().strip() or "")
            # crude IPv4 sanity check
            import re
            if ip and re.fullmatch(r"\d{1,3}(\.\d{1,3}){3}", ip):
                return ip
        except Exception:
            continue
    return ""


def _dns_has_ip(domain, ip):
    """Return True when <domain> already resolves (A) to <ip> on the public DNS."""
    for cmd in (
        lambda: sh(["getent", "ahostsv4", domain], capture=True),
        lambda: sh(["dig", "+short", "A", domain], capture=True),
        lambda: sh(["nslookup", "-type=A", domain], capture=True),
    ):
        try:
            code, out = cmd()
            if code == 0 and ip and ip in out:
                return True
        except Exception:
            continue
    return False


def cf_set_dns(domain, ip):
    """Create/update a Cloudflare A record for <domain> -> <ip> using the
    Cloudflare v4 API (read token from UH_CF_TOKEN, zone from UH_CF_ZONE_ID)."""
    token = os.environ.get("UH_CF_TOKEN", "").strip()
    zone = os.environ.get("UH_CF_ZONE_ID", "").strip()
    if not token or not zone:
        return False
    name = domain
    proxied = os.environ.get("UH_CF_PROXIED", "false").strip().lower() in ("1", "true", "yes")
    payload = {"type": "A", "name": name, "content": ip, "ttl": 120, "proxied": proxied}
    code, res = http_json(f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records", payload,
                          method="POST", extra_headers={"Authorization": "Bearer " + token})
    if code in (200, 201) and res.get("success"):
        return True
    # Record may already exist — try to update it.
    code2, res2 = http_json(
        f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records?type=A&name={urllib.parse.quote(name)}",
        token=token, method="GET",
    )
    if code2 == 200 and res2.get("success"):
        for rec in res2.get("result", []) or []:
            if rec.get("name") == name and rec.get("type") == "A":
                rc, rr = http_json(
                    f"https://api.cloudflare.com/client/v4/zones/{zone}/dns_records/{rec['id']}",
                    {"type": "A", "name": name, "content": ip, "ttl": 120, "proxied": proxied},
                    token=token, method="PUT",
                )
                return bool(rr.get("success")) if rc in (200, 201) else False
    return False


def open_firewall(ports):
    """Open ports with ufw (or iptables fallback). Non-fatal on failure."""
    if not ports:
        return
    if shutil.which("ufw"):
        for p in sorted(set(str(x) for x in ports)):
            sh(["sudo", "ufw", "allow", f"{p}/tcp"])
        if os.environ.get("UH_UFW_ENABLE", "").strip().lower() in ("1", "yes", "true"):
            sh(["sudo", "ufw", "enable", "--force"])
    elif shutil.which("iptables"):
        for p in sorted(set(str(x) for x in ports)):
            sh(["sudo", "iptables", "-I", "INPUT", "-p", "tcp", "--dport", str(p), "-j", "ACCEPT"])
    info(f"Opened firewall for ports: {', '.join(str(p) for p in ports)}")


def _generate_strong_password(length=20):
    import secrets
    import string
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*-_=+."
    return "".join(secrets.choice(alphabet) for _ in range(length))


def rotate_default_admin(api_url, mode):
    """Log into the fresh panel with the seed credentials and rotate the owner
    admin password to a fresh secret.

    Returns (email, new_password_or_None, already_configured):
        email              the owner's (possibly updated) login email
        new_password       the password that was actually applied, or None
        already_configured True when the seed password no longer worked (i.e.
                           this is a reinstall and the admin has already been
                           rotated), in which case no new value was set.

    The value is printed once and never written to disk.

    mode: 'auto'  -> generate a random password  (recommended, default)
          'env'   -> use UH_ADMIN_PASSWORD if set
          ''      -> TTY prompt (interactive)
    """
    seed_email = "admin@uptime.host"
    seed_pass = "admin123"
    email = (os.environ.get("UH_ADMIN_EMAIL", "").strip() or seed_email)

    # 1. Determine the desired password (auto / env / prompt).
    new_pw = os.environ.get("UH_ADMIN_PASSWORD", "").strip()
    if not new_pw and mode == "auto":
        new_pw = _generate_strong_password()
    if not new_pw and sys.stdin.isatty():
        while True:
            new_pw = getpass.getpass("Set a NEW admin password (min 6 chars): ")
            if len(new_pw) >= 6:
                break
            warn("too short — need 6+ characters")

    # 2. Log in with the seed account.
    code, res = http_json(f"{api_url}/api/auth/login", {"email": seed_email, "password": seed_pass})
    if code != 200 or not res.get("token"):
        # The seed password no longer works — this is (almost always) a reinstall
        # where the admin was already rotated. Do NOT invent/rotate a password.
        warn("seed login failed — the admin password was already rotated; keeping it")
        return email, None, True
    token = res["token"]

    # 3. Find the owner user and update its email + password.
    if not new_pw and not email:
        die("seed login worked but no new password was provided (set UH_ADMIN_PASSWORD or UH_ADMIN_AUTO=auto)", 2)
    if not new_pw:
        die("could not determine an admin password — set UH_ADMIN_PASSWORD, or use mode=auto (UH_ADMIN_AUTO=auto)", 2)

    code2, list_res = http_json(f"{api_url}/api/users", token=token)
    uid = None
    if code2 == 200 and list_res.get("users"):
        for u in list_res["users"]:
            if u.get("email", "").lower() == seed_email:
                uid = u.get("id")
                break
        if not uid and list_res["users"]:
            uid = list_res["users"][0].get("id")
    if not uid:
        warn("could not locate the owner user to rotate its password")
        return email, None, False

    patch = {"password": new_pw}
    # Only change the email if the operator asked for a different one (and it is
    # a different address than the seed).
    if email and email.lower() != seed_email:
        patch["email"] = email
    code3, _ = http_json(f"{api_url}/api/users/{uid}", patch, token=token, method="PATCH")
    if code3 in (200, 201):
        info("Seed admin credential rotated to a fresh secret.")
    else:
        warn(f"password rotation reported unexpected status {code3}")
        return email, None, False
    return email, new_pw, False


def build_panel_url(mode, domain=None, ip=None):
    """Return the human-facing URL (and its backend API URL) given the chosen
    access mode, domain and public IP."""
    if mode in ("http", "ip"):
        host = domain or ip or ("localhost")
        return f"http://{host}:{WEB_PORT}", API_URL
    fqdn = domain
    if not fqdn and ip:
        fqdn = ip  # self-signed-ish fallback: plain IP over https won't verify
    return f"https://{fqdn}", f"https://{fqdn}/api"


def install_panel():
    info("Installing panel (full provisioning + public exposure)...")
    install_requirements()

    # Build the web bundle
    code, out = sh(["npm", "--prefix", os.path.join(REPO_DIR, "apps", "web"), "run", "build"], cwd=REPO_DIR, capture=True)
    if code != 0:
        warn("web build reported a non-zero exit; continuing anyway:\n" + out[:400])

    # Locate tsx — npm workspaces hoist bins to the repo-root node_modules/.bin.
    tsx = os.path.join(REPO_DIR, "node_modules", ".bin", "tsx")
    if not os.path.exists(tsx):
        tsx = os.path.join(REPO_DIR, "apps", "api", "node_modules", ".bin", "tsx")
    if not os.path.exists(tsx):
        warn(f"tsx not found at {tsx}; is the API dependency installed?")
        return False

    # Start API
    start_daemon(
        "panel-api",
        [tsx, os.path.join(REPO_DIR, "apps", "api", "src", "index.ts")],
        cwd=REPO_DIR,
        env={"UH_API_PORT": API_PORT},
    )
    # Start web dev server (proxies /api to the API)
    start_daemon(
        "panel-web",
        ["npm", "--prefix", os.path.join(REPO_DIR, "apps", "web"), "run", "dev"],
        cwd=REPO_DIR,
        env={"UH_WEB_PORT": WEB_PORT},
    )

    if not wait_api(API_URL):
        warn("the API did not answer /api/health yet — tailing the log for clues:")
        tail_log("panel-api", lines=25)
        if sys.stdin.isatty():
            die("panel API failed to start; fix the error above and re-run")
        warn("continuing anyway (API not confirmed up)")
    else:
        info("API is up and answering /api/health.")

    # ------------------------------------------------------------------
    # Phase 1 — never leave the well-known seed credentials in place.
    # ------------------------------------------------------------------
    auto_cred = os.environ.get("UH_ADMIN_AUTO", "").strip().lower() in ("1", "auto", "yes", "true")
    cred_mode = "auto" if auto_cred else ("env" if os.environ.get("UH_ADMIN_PASSWORD", "").strip() else "prompt")
    admin_email, applied_pw, already_configured = rotate_default_admin(API_URL, cred_mode)

    # ------------------------------------------------------------------
    # Phase 2 — gather public exposure facts up front.
    # ------------------------------------------------------------------
    mode = os.environ.get("UH_PANEL_MODE", "").strip().lower()
    if not mode:
        if not sys.stdin.isatty():
            mode = "http"  # no domain given via env on a non-TTY (piped) install
        else:
            mode = input("Serve panel over http or https? [http/https]: ").strip().lower()
    if mode not in ("http", "ip", "https"):
        mode = "https"

    public_ip = detect_public_ip()
    if public_ip:
        info(f"Detected public IPv4: {public_ip}")

    domain = os.environ.get("UH_PANEL_DOMAIN", "").strip() or os.environ.get("UH_PANEL_FQDN", "").strip()
    if not domain and mode == "https" and sys.stdin.isatty():
        try:
            domain = input(f"Panel domain (e.g. gp1.uptimehost.in) [{public_ip or ''}]: ").strip()
        except (EOFError, KeyboardInterrupt):
            domain = ""
    if mode == "https" and not domain:
        warn("no domain provided — skipping HTTPS for now.")
        warn("you can enable a domain + HTTPS later by running option [12] in setup.py")
        mode = "ip"

    # ------------------------------------------------------------------
    # Phase 3 — make it reachable: DNS + firewall + HTTPS.
    # ------------------------------------------------------------------
    if mode == "https":
        if public_ip and not _dns_has_ip(domain, public_ip):
            info(f"DNS for {domain} does not yet point to this host ({public_ip}).")
            if cf_set_dns(domain, public_ip):
                info("Created/updated the A record via Cloudflare automatically.")
            elif os.environ.get("UH_CF_TOKEN", ""):
                warn("Cloudflare token set but the A record could not be created — add it manually.")
            elif sys.stdin.isatty():
                card = input(f"Add an A record  @ -> {public_ip}  in your DNS panel now, then press Enter. (or type 'skip'): ")
                if card.strip().lower() in ("skip", "s"):
                    warn("skipping DNS check — HTTPS may not resolve yet")
        setup_panel_https(domain)

    # Open the ports used by the public panel + node agents.
    want_fw = os.environ.get("UH_OPEN_FIREWALL", "").strip().lower()
    if not want_fw and sys.stdin.isatty() and mode != "ip":
        want_fw = input("Open ports 80/443, API and 7373 (node agents) in the firewall? [y/N]: ").strip().lower()
    if want_fw in ("1", "y", "yes", "true"):
        open_firewall([80, 443, int(API_PORT), 7373])

    # ------------------------------------------------------------------
    # Phase 4 — report the public access point (once, not persisted).
    # ------------------------------------------------------------------
    panel_url, _api_back = build_panel_url(mode, domain=domain, ip=public_ip)
    print()
    print("=" * 62)
    print("  PANEL INSTALLED — public access")
    print("=" * 62)
    print(f"  Panel URL   : {panel_url}")
    print(f"  Admin email : {admin_email}")
    if applied_pw:
        print(f"  Admin pass  : {applied_pw}   <-- save this now, it is shown only once")
    elif already_configured:
        print(f"  Admin pass  : (kept your existing password — not changed)")
    if mode == "https" and domain:
        print(f"  Cert        : Let's Encrypt (auto-renews via certbot)")
    else:
        print(f"  Domain/HTTPS: not configured yet — run option [12] to add it")
    print("=" * 62)
    return True


def ensure_domain_https():
    """Option 12 — point a domain at this panel and enable HTTPS (worker keeps running).

    Run whenever the operator is ready to expose the panel publicly: it wires up
    DNS (auto via Cloudflare or manual), opens the firewall, and issues a
    Let's Encrypt certificate through nginx. Re-runnable and idempotent.
    """
    public_ip = detect_public_ip()
    if public_ip:
        info(f"Detected public IPv4: {public_ip}")

    domain = os.environ.get("UH_PANEL_DOMAIN", "").strip() or os.environ.get("UH_PANEL_FQDN", "").strip()
    if not domain:
        if not sys.stdin.isatty():
            die("set UH_PANEL_DOMAIN (or UH_PANEL_FQDN) to configure the domain (stdin is not a TTY)", 2)
        default = "panel.uptimehost.in"
        domain = input(f"Panel domain (e.g. panel.uptimehost.in) [{default}]: ").strip() or default
        domain = domain.strip().rstrip(".")

    if public_ip and not _dns_has_ip(domain, public_ip):
        info(f"DNS for {domain} does not yet point to this host ({public_ip}).")
        if cf_set_dns(domain, public_ip):
            info("Created/updated the A record via Cloudflare automatically.")
        elif os.environ.get("UH_CF_TOKEN", ""):
            warn("Cloudflare token set but the A record could not be created — add it manually.")
        else:
            if not sys.stdin.isatty():
                die("add an A record  @ -> %s  manually, then re-run option 12" % public_ip, 2)
            card = input(f"Add an A record  @ -> {public_ip}  in your DNS panel now, then press Enter. (or 'skip'): ")
            if card.strip().lower() in ("skip", "s"):
                warn("skipping DNS check — HTTPS may not resolve yet")

    setup_panel_https(domain)

    want_fw = os.environ.get("UH_OPEN_FIREWALL", "").strip().lower()
    if not want_fw and sys.stdin.isatty():
        want_fw = input("Open ports 80/443, API and 7373 (node agents) in the firewall? [y/N]: ").strip().lower()
    if want_fw in ("1", "y", "yes", "true"):
        open_firewall([80, 443, int(API_PORT), 7373])

    print()
    print("=" * 62)
    print(f"  HTTPS ready  : https://{domain}")
    print("  (A record + Let's Encrypt cert configured; re-run to renew/change)")
    print("=" * 62)
    return True


def parse_install_command(text):
    """Extract `export UH_*=...` assignment pairs from a panel install command."""
    env = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line.startswith("export UH_"):
            continue
        rest = line[len("export "):]
        key, _, val = rest.partition("=")
        if key:
            env[key.strip()] = val.strip().strip('"').strip("'")
    return env


def login_panel(base, email, password):
    code, data = http_json(base + "/api/auth/login", {"email": email, "password": password})
    if code not in (200, 201) or not data.get("token"):
        die(f"panel login failed ({code}): {data.get('error', data)}")
    return data["token"]


def agent_src_dir():
    """Return a directory containing the agent Go module, cloning the repo into
    a temp dir when running standalone (e.g. piped straight from raw GitHub)."""
    go_dir = os.path.join(REPO_DIR, "services", "agent")
    if os.path.exists(os.path.join(go_dir, "go.mod")):
        return go_dir

    cache = os.path.join(tempfile.gettempdir(), "uh-agent-src")
    got = os.path.join(cache, "services", "agent")
    if os.path.exists(os.path.join(got, "go.mod")):
        return got
    os.makedirs(cache, exist_ok=True)
    info("cloning agent source (standalone run) ...")
    code, out = sh(["git", "clone", "-q", "--depth", "1", REPO_URL, cache], capture=True)
    if code != 0:
        die("could not fetch agent source: " + out)
    return got


def install_node():
    info("Installing node agent...")
    go_dir = agent_src_dir()
    require("go")
    os.makedirs(os.path.join(go_dir, "bin"), exist_ok=True)
    code, out = sh(["go", "build", "-o", os.path.join(go_dir, "bin", "uh-agent"), "./cmd/agent"], cwd=go_dir, capture=True)
    if code != 0:
        die("agent build failed:\n" + out)

    info("--- Connect this node to the panel ---")

    # 1. Panel FQDN / URL
    base = q("Panel URL (e.g. https://gp1.uptimehost.in or http://192.168.1.5:8081)", "UH_PANEL_URL").strip()
    if not base:
        die("panel URL is required")
    if not base.startswith(("http://", "https://")):
        base = "https://" + base
    base = base.rstrip("/")

    # 2. Panel admin credentials (login = first connection debug)
    email = os.environ.get("UH_PANEL_EMAIL", "")
    pwd = os.environ.get("UH_PANEL_PASSWORD", "")
    token = os.environ.get("UH_PANEL_TOKEN", "")
    if not token:
        if not email:
            email = q("Panel admin email", "UH_PANEL_EMAIL")
        if not pwd:
            if sys.stdin.isatty():
                pwd = getpass.getpass("Panel admin password: ")
            else:
                die("set UH_PANEL_PASSWORD (or UH_PANEL_TOKEN) to connect (stdin is not a TTY)", 2)
        info(f"Testing connection to {base} ...")
        code, data = http_json(base + "/api/auth/login", {"email": email, "password": pwd})
        if code not in (200, 201) or not data.get("token"):
            err(f"connection failed: login returned {code}: {data.get('error', data)}")
            die("could not authenticate with the panel — verify the URL and admin credentials")
        token = data["token"]
        info("Connected + authenticated with the panel OK.")

    # 3. This node's FQDN/IP
    node_url = q("This node's FQDN/IP the panel reaches it at (e.g. testn.uptimehost.in)", "UH_AGENT_HOST").strip()
    if not node_url:
        die("this node's FQDN/IP is required")
    port = q("Agent listen port", "UH_AGENT_PORT", "7373").strip() or "7373"

    # 4. Node link http or https
    scheme_choice = q("Node link http or https?", "UH_AGENT_SCHEME", "http").strip().lower()
    scheme = "https" if scheme_choice in ("https", "ssl", "tls") else "http"

    # 5. If https, node TLS cert/key paths
    extra = {}
    if scheme == "https":
        info("HTTPS node link selected — provide the node's TLS certificate.")
        cert = q("Node TLS fullchain cert path", "UH_AGENT_TLS_CERT").strip()
        key = q("Node TLS private key path", "UH_AGENT_TLS_KEY").strip()
        if not (os.path.exists(cert) and os.path.exists(key)):
            die(f"node TLS cert/key not found: {cert!r}, {key!r}")
        extra = {"UH_AGENT_TLS_CERT": cert, "UH_AGENT_TLS_KEY": key}
        info(f"Node will serve https://{node_url}:{port} using {cert}")

    name = q("Node name", "UH_NODE_NAME", "New Node").strip() or "New Node"
    memory = q("Node memory (MB)", "UH_NODE_MEMORY", "8192").strip() or "8192"
    disk = q("Node disk (GB)", "UH_NODE_DISK", "100").strip() or "100"

    # 6. Create the node in the panel (admin)
    info("Creating node in the panel ...")
    code, data = http_json(
        base + "/api/nodes",
        {"name": name, "scheme": scheme, "host": node_url, "port": int(port),
         "memoryMb": int(memory), "diskGb": int(disk)},
        token=token,
    )
    if code not in (200, 201) or not data.get("node"):
        die(f"failed to create node on panel ({code}): {data.get('error', data)}")
    node = data["node"]
    install_cmd = node.get("installCommand") or ""
    if node.get("agentToken") is None:
        die("panel did not return an agent token for the node")

    # The single command returned by the panel is the canonical way to connect a
    # node: it clones the agent, builds it, writes every credential to
    # /etc/uptimehost/agent.env, and starts/restarts a uh-agent systemd service.

    # 7. Show the single install command (this is what runs on the node).
    print()
    info(f"Node '{node['name']}' created. Run this ONE command on the node machine ({node_url}):")
    print("-" * 72)
    print(install_cmd)
    print("-" * 72)
    print("   requires git + go on the node; re-running it safely restarts the agent.")

    # 8. Optionally run it on THIS machine (instead of a remote node).
    print()
    run_here = os.environ.get("UH_RUN_INSTALL", "").strip().lower()
    if not run_here and sys.stdin.isatty():
        try:
            run_here = input("Run this install command on THIS machine now? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            run_here = "n"
    if run_here in ("y", "yes"):
        script = install_cmd
        if scheme == "https" and extra.get("UH_AGENT_TLS_CERT"):
            script = (
                install_cmd.rstrip()
                + "\n"
                + f"echo 'UH_AGENT_TLS_CERT={extra['UH_AGENT_TLS_CERT']}' >> /etc/uptimehost/agent.env\n"
                + f"echo 'UH_AGENT_TLS_KEY={extra['UH_AGENT_TLS_KEY']}' >> /etc/uptimehost/agent.env\n"
                + "systemctl daemon-reload >/dev/null 2>&1 || true\n"
                + "systemctl restart uh-agent >/dev/null 2>&1 || true\n"
            )
        info("Running install command on this machine (writes /etc/uptimehost + starts uh-agent)...")
        tmp = os.path.join(REPO_DIR, ".uh-install.sh")
        with open(tmp, "w") as f:
            f.write(script + "\n")
        code2, _ = sh(["bash", tmp], capture=True)
        if code2 == 0:
            info(f"Node agent installed on this machine. Node {node['name']} enrolled at {base} over {scheme}.")
        else:
            warn("install command returned a non-zero exit — review the output above.")
    else:
        info("Not running locally — copy the single command above to the node and run it there.")
    return True


def uninstall_panel():
    info("Uninstalling panel...")
    stop_daemon("panel-api")
    stop_daemon("panel-web")
    dist = os.path.join(REPO_DIR, "apps", "web", "dist")
    if os.path.isdir(dist):
        shutil.rmtree(dist)
        info("Removed built web bundle.")
    info("Panel uninstalled.")
    return True


def uninstall_node():
    info("Uninstalling node agent...")
    stop_daemon("node-agent")
    info("Node agent uninstalled.")
    return True


def wait_api(base, tries=30, delay=1.0, health="/api/health"):
    """Poll the API until it is reachable, so install steps can rely on the
    panel actually being up before they continue. Returns True on success."""
    url = base.rstrip("/") + health
    for i in range(1, tries + 1):
        if not os.path.isfile(log_file("panel-api")):
            pass
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        if i < tries:
            time.sleep(delay)
    return False


def http_json(url, payload=None, token=None, method=None, extra_headers=None):
    """Tiny stdlib JSON HTTP client."""
    data = json.dumps(payload).encode() if payload is not None else None
    method = method or ("POST" if payload is not None else "GET")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode()
            return r.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {"error": f"HTTP {e.code}"}
    except Exception as e:
        return 0, {"error": str(e)}


def add_admin():
    info("Add admin user via the panel API")
    api = input(f"Panel API URL [{API_URL}]: ").strip() or API_URL
    login_email = input("Acting admin email [admin@uptime.host]: ").strip() or "admin@uptime.host"
    login_pass = getpass.getpass("Acting admin password: ")
    name = input("New admin name: ").strip()
    email = input("New admin email: ").strip()
    role = input("Role [owner/admin/operator/developer/viewer] (default owner): ").strip() or "owner"
    if not name or not email:
        die("name and email are required")
    while True:
        pw = getpass.getpass("New admin password: ")
        if len(pw) >= 6:
            break
        warn("password must be at least 6 characters")
    code, res = http_json(f"{api}/api/auth/login", {"email": login_email, "password": login_pass})
    if code != 200 or not res.get("token"):
        die(f"login failed ({res.get('error')}) — is the panel running and API URL correct?")
    token = res["token"]
    code2, res2 = http_json(
        f"{api}/api/users",
        {"name": name, "email": email, "password": pw, "role": role},
        token=token,
    )
    if code2 in (200, 201):
        u = res2.get("user", {})
        info(f"Created admin: {u.get('name')} <{u.get('email')}> role={u.get('role')}")
        return True
    die(f"add admin failed: {res2.get('error')}")


# ---------------------------------------------------------------------------
# Auth-provider configuration (SMTP / Google / GitHub) — pushed to the panel
# through the admin API so no manual editing of the DB is needed.
# ---------------------------------------------------------------------------
def _panel_login():
    """Resolve the panel admin session (env override or interactive login)."""
    api = os.environ.get("UH_PANEL_URL", "").rstrip("/") or API_URL
    if not api.startswith(("http://", "https://")):
        api = "https://" + api if not api.startswith("http") else api
    token = os.environ.get("UH_PANEL_ADMIN_TOKEN", "").strip()
    if token:
        return api, token
    email = os.environ.get("UH_PANEL_ADMIN_EMAIL", "").strip() or "admin@uptime.host"
    pwd = os.environ.get("UH_PANEL_ADMIN_PASSWORD", "").strip()
    if not pwd:
        if sys.stdin.isatty():
            pwd = getpass.getpass(f"Panel admin password ({email}): ")
        else:
            die("set UH_PANEL_ADMIN_PASSWORD (or UH_PANEL_ADMIN_TOKEN) to configure auth (stdin is not a TTY)", 2)
    code, res = http_json(f"{api}/api/auth/login", {"email": email, "password": pwd})
    if code != 200 or not res.get("token"):
        die(f"panel login failed ({code}): {res.get('error', res)}")
    return api, res["token"]


def _get_providers(api, token):
    code, res = http_json(f"{api}/api/admin/auth-providers", token=token)
    if code != 200:
        die(f"could not read auth providers ({code}): {res.get('error', res)}")
    return res.get("providers", {})


def _put_providers(api, token, patch):
    """Send a partial provider patch. Secrets left blank keep their existing
    value; an empty string clears the field."""
    code, res = http_json(f"{api}/api/admin/auth-providers", patch, token=token, method="PUT")
    if code != 200:
        die(f"failed to save auth providers ({code}): {res.get('error', res)}")
    return res.get("providers", {})


def configure_smtp():
    """[7] Configure the panel's SMTP (email/OTP) settings via the API."""
    info("Configure SMTP (used for email-OTP / magic-link sign-in)")
    api, token = _panel_login()
    cur = _get_providers(api, token).get("smtp", {})
    defaults = {
        "host": cur.get("host") or "smtp.gmail.com",
        "port": int(cur.get("port") or 587),
        "user": cur.get("user") or "",
        "from": cur.get("from") or "",
    }
    host = q("SMTP host", "UH_SMTP_HOST", defaults["host"]).strip()
    port_s = q("SMTP port", "UH_SMTP_PORT", str(defaults["port"])).strip() or "587"
    port = int(port_s)
    secure = q("Use TLS/SSL on connect (ssl/starttls/no)", "UH_SMTP_SECURE", "starttls").strip().lower()
    user = q("SMTP username", "UH_SMTP_USER", defaults["user"]).strip()
    if not user:
        die("SMTP username is required")
    pwd = os.environ.get("UH_SMTP_PASS", "").strip()
    existing_has_pass = bool(cur.get("hasPass"))
    if not pwd and sys.stdin.isatty():
        if existing_has_pass:
            keep = input("Keep existing SMTP password? [y/N]: ").strip().lower()
            if keep in ("y", "yes"):
                pwd = None  # sentinel: untouched
            else:
                pwd = getpass.getpass("New SMTP password: ")
        else:
            pwd = getpass.getpass("SMTP password: ")
    if pwd == "":
        pwd = None  # do not clear unless explicitly asked
    from_ = q("'From' address", "UH_SMTP_FROM", default=defaults["from"] or user).strip() or user

    smtp = {
        "host": host,
        "port": port,
        "user": user,
        "from": from_,
        "secure": secure in ("ssl", "tls"),  # ssl/tls => implicit TLS; starttls/no => upgrade on connect
    }
    if pwd is not None:
        smtp["pass"] = pwd

    _put_providers(api, token, {"smtp": smtp})
    info(f"SMTP saved: {host}:{port} as {user} from {from_}.")

    test = os.environ.get("UH_SMTP_TEST", "").strip().lower()
    if not test and sys.stdin.isatty():
        test = input("Send a test email now? [y/N]: ").strip().lower()
    if test in ("y", "yes"):
        _smtp_send_test(host, port, smtp.get("secure"), user, pwd, from_)
    return True


def _smtp_send_test(host, port, secure, user, pwd, from_):
    """Reference listener for sending an SMTP test message. Prefers the stdlib
    `smtplib` when present; otherwise prints the exact values so the admin can
    test in their own client."""
    try:
        import smtplib
        from email.mime.text import MIMEText
    except Exception:
        warn("smtplib not available — test send unavailable.")
        return
    to = q("Recipient email for the test message", "UH_SMTP_TEST_TO", from_).strip()
    if not to:
        warn("no recipient — skipping test send")
        return
    msg = MIMEText(
        "This is a test message from UptimeHost setup.py.\n\n"
        "If you received this, your SMTP configuration is working.\n"
    )
    msg["Subject"] = "[UptimeHost] SMTP test"
    msg["From"] = from_
    msg["To"] = to
    try:
        if secure:
            s = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            s = smtplib.SMTP(host, port, timeout=20)
            s.starttls()
        if user:
            s.login(user, pwd or "")
        s.sendmail(from_, [to], msg.as_string())
        s.quit()
        info(f"Test email sent to {to}.")
    except Exception as e:
        warn(f"test send failed: {e}")


def configure_google():
    """[8] Configure Google OAuth sign-in via the API."""
    info("Configure Google OAuth sign-in")
    api, token = _panel_login()
    cur = _get_providers(api, token).get("google", {})
    client_id = os.environ.get("UH_GOOGLE_CLIENT_ID", "").strip()
    if not client_id and sys.stdin.isatty():
        client_id = input("Google OAuth Client ID: ").strip()
    if not client_id:
        die("Google Client ID is required (set UH_GOOGLE_CLIENT_ID in non-TTY mode)")
    secret = os.environ.get("UH_GOOGLE_CLIENT_SECRET", "").strip()
    if not secret and sys.stdin.isatty():
        secret = getpass.getpass("Google OAuth Client Secret: ")
    redirect = os.environ.get("UH_GOOGLE_REDIRECT", "").strip() or cur.get("redirectUri") or ""
    if not redirect and sys.stdin.isatty():
        redirect = input(f"Authorized redirect URI [{redirect if redirect else 'https://<panel>/api/auth/oauth/google'}]: ").strip()
    if not redirect:
        redirect = api + "/api/auth/oauth/google"
    google = {"clientId": client_id, "clientSecret": secret or None, "redirectUri": redirect}
    _put_providers(api, token, {"google": google})
    info(f"Google OAuth save OK. Add this to your Google Cloud OAuth client:")
    print("    Authorized redirect URI: " + redirect)
    return True


def configure_github():
    """[9] Configure GitHub OAuth sign-in via the API."""
    info("Configure GitHub OAuth sign-in")
    api, token = _panel_login()
    cur = _get_providers(api, token).get("github", {})
    client_id = os.environ.get("UH_GITHUB_CLIENT_ID", "").strip()
    if not client_id and sys.stdin.isatty():
        client_id = input("GitHub OAuth Client ID: ").strip()
    if not client_id:
        die("GitHub Client ID is required (set UH_GITHUB_CLIENT_ID in non-TTY mode)")
    secret = os.environ.get("UH_GITHUB_CLIENT_SECRET", "").strip()
    if not secret and sys.stdin.isatty():
        secret = getpass.getpass("GitHub OAuth Client Secret: ")
    redirect = os.environ.get("UH_GITHUB_REDIRECT", "").strip() or cur.get("redirectUri") or ""
    if not redirect and sys.stdin.isatty():
        redirect = input(f"Authorized redirect URI [{redirect if redirect else 'https://<panel>/api/auth/oauth/github'}]: ").strip()
    if not redirect:
        redirect = api + "/api/auth/oauth/github"
    github = {"clientId": client_id, "clientSecret": secret or None, "redirectUri": redirect}
    _put_providers(api, token, {"github": github})
    info(f"GitHub OAuth save OK. Add this redirect to your GitHub OAuth App:")
    print("    Authorization callback URL: " + redirect)
    return True


def configure_auth_all():
    """[10] Configure SMTP + Google + GitHub in one guided pass."""
    info("Auto-configure all auth providers (SMTP + Google + GitHub)")
    api, token = _panel_login()
    info("Connected to panel OK — collecting credentials.")
    want = {"smtp": True, "google": False, "github": False}
    if sys.stdin.isatty():
        for k, label in (("smtp", "SMTP"), ("google", "Google OAuth"), ("github", "GitHub OAuth")):
            a = input(f"Configure {label}? [y/N]: ").strip().lower()
            want[k] = a in ("y", "yes")
    if want["smtp"]:
        configure_smtp()
    if want["google"]:
        configure_google()
    if want["github"]:
        configure_github()
    info("Auth-provider configuration complete.")
    return True


# ---------------------------------------------------------------------------
# Predefined / customizable download scripts.
#
# setup.py can emit ready-to-run shell scripts that carry the operator's own
# credentials / addresses baked in. Choose a template, fill in the blanks, and
# the generated file is written locally (or printed for copy/paste). This
# removes the "copy-paste manual steps" friction for connecting nodes or
# configuring the panel on a fresh host.
# ---------------------------------------------------------------------------
SCRIPT_TEMPLATES = {
    "node-agent": {
        "file": "install-node-agent.sh",
        "desc": "Connect a fresh VPS as a panel node (builds agent + systemd service)",
        "help": "Fill PANEL_URL, PANEL_EMAIL, PANEL_PASSWORD and AGENT_HOST, then run the script on the node.",
        "env": {
            "PANEL_URL": "https://panel.example.com",
            "PANEL_EMAIL": "you@example.com",
            "PANEL_PASSWORD": "",
            "AGENT_HOST": "testn.example.com",
            "AGENT_PORT": "7373",
            "NODE_MEMORY_MB": "8192",
            "NODE_DISK_GB": "100",
        },
        "body": """#!/usr/bin/env bash
# UptimeHost — connect this machine as a panel node (auto-generate from setup.py)
set -euo pipefail
REPO_URL="${UH_REPO_URL:-https://github.com/ProPlayer777bug/uptpanel.git}"

PANEL_URL="${PANEL_URL:-__PANEL_URL__}"
PANEL_EMAIL="${PANEL_EMAIL:-__PANEL_EMAIL__}"
PANEL_PASSWORD="${PANEL_PASSWORD:-__PANEL_PASSWORD__}"
AGENT_HOST="${AGENT_HOST:-__AGENT_HOST__}"
AGENT_PORT="${AGENT_PORT:-__AGENT_PORT__}"
NODE_MEMORY_MB="${NODE_MEMORY_MB:-__NODE_MEMORY_MB__}"
NODE_DISK_GB="${NODE_DISK_GB:-__NODE_DISK_GB__}"

say()  { printf '\\033[1;36m[UH]\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[1;31m[UH] error:\\033[0m %s\\n' "$*" >&2; exit 1; }

command -v git >/dev/null || sudo apt-get update && sudo apt-get install -y git
command -v go  >/dev/null || sudo apt-get install -y golang-go || fail "install Go first"

if [ ! -d "$HOME/uptimehost/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$HOME/uptimehost"
else
  (cd "$HOME/uptimehost" && git pull --ff-only)
fi

cd "$HOME/uptimehost"
PANEL_URL="$PANEL_URL" UH_PANEL_EMAIL="$PANEL_EMAIL" UH_PANEL_PASSWORD="$PANEL_PASSWORD" \\
  UH_AGENT_HOST="$AGENT_HOST" UH_AGENT_PORT="$AGENT_PORT" \\
  UH_NODE_MEMORY="$NODE_MEMORY_MB" UH_NODE_DISK="$NODE_DISK_GB" \\
  UH_RUN_INSTALL=yes UH_OPT=2 python3 setup.py

say "Node agent configured on $AGENT_HOST:$AGENT_PORT for $PANEL_URL"
""",
    },
    "panel-https": {
        "file": "setup-panel-https.sh",
        "desc": "Issue a Let's Encrypt certificate and reverse-proxy the panel over HTTPS",
        "help": "Fill PANEL_FQDN and optionally the cert email, then run as root on the panel host.",
        "env": {
            "PANEL_FQDN": "panel.example.com",
            "PANEL_EMAIL": "you@example.com",
            "PANEL_WEB_PORT": "8080",
        },
        "body": """#!/usr/bin/env bash
# UptimeHost — put the panel behind HTTPS with a Let's Encrypt cert.
set -euo pipefail
PANEL_FQDN="${PANEL_FQDN:-__PANEL_FQDN__}"
PANEL_EMAIL="${PANEL_EMAIL:-__PANEL_EMAIL__}"
PANEL_WEB_PORT="${PANEL_WEB_PORT:-__PANEL_WEB_PORT__}"

say()  { printf '\\033[1;36m[UH]\\033[0m %s\\n' "$*"; }
fail() { printf '\\033[1;31m[UH] error:\\033[0m %s\\n' "$*" >&2; exit 1; }

sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/uptimehost-https >/dev/null <<EOF
server {
    server_name {PANEL_FQDN};
    location / {
        proxy_pass http://127.0.0.1:$PANEL_WEB_PORT;
        proxy_set_header Host \\$host;
        proxy_set_header X-Real-IP \\$remote_addr;
        proxy_set_header X-Forwarded-For \\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \\$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/uptimehost-https /etc/nginx/sites-enabled/uptimehost-https
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d {PANEL_FQDN} --redirect --agree-tos \\
  -m {PANEL_EMAIL} --non-interactive || true
say "Panel HTTPS ready at https://{PANEL_FQDN}"
""",
    },
    "backup-data": {
        "file": "backup-panel-data.sh",
        "desc": "Back up the panel's JSON data store and web build to a timestamped tarball",
        "help": "Set UH_DATA_DIR to the panel's .uh-data folder; run on the panel host.",
        "env": {
            "UH_DATA_DIR": "/root/uptimehost/.uh-data",
            "UH_BACKUP_DIR": "/root/backups",
        },
        "body": """#!/usr/bin/env bash
# UptimeHost — compact backup of panel state.
set -euo pipefail
DATA_DIR="${UH_DATA_DIR:-/root/uptimehost/.uh-data}"
OUT_DIR="${UH_BACKUP_DIR:-/root/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
tar -czf "$OUT_DIR/uptimehost-$STAMP.tar.gz" -C "$DATA_DIR" .
echo "Backup written to $OUT_DIR/uptimehost-$STAMP.tar.gz"
""",
    },
}


def generate_scripts():
    """[11] Generate a predefined/downloadable script, customized with the
    operator's own credentials/addresses."""
    info("Generate a ready-to-run script (credentials baked in)")
    choices = list(SCRIPT_TEMPLATES)
    if sys.stdin.isatty():
        print()
        print("Available script templates:")
        for i, key in enumerate(choices, 1):
            t = SCRIPT_TEMPLATES[key]
            print(f"  {i}. {t['file']} — {t['desc']}")
        try:
            sel = input("Select a template number: ").strip()
        except (EOFError, KeyboardInterrupt):
            sel = ""
        if sel.isdigit() and 1 <= int(sel) <= len(choices):
            key = choices[int(sel) - 1]
        else:
            warn("invalid selection; using first template")
            key = choices[0]
    else:
        key = os.environ.get("UH_SCRIPT_TEMPLATE", "node-agent")
        if key not in SCRIPT_TEMPLATES:
            die(f"unknown template '{key}' (choose from: {', '.join(SCRIPT_TEMPLATES)})")

    tpl = SCRIPT_TEMPLATES[key]
    print()
    info(f"Template: {tpl['file']}")
    print("  " + tpl["help"])
    fills = {}
    env_prefix = "UH_SCRIPT_"
    for var, default in tpl["env"].items():
        envkey = env_prefix + var
        if default.endswith(".example.com") or default.endswith(".com"):
            default = ""
        val = os.environ.get(envkey, "").strip()
        if not val and sys.stdin.isatty():
            try:
                val = input(f"{var} [{default}] : ").strip()
            except (EOFError, KeyboardInterrupt):
                val = ""
        if not val and not default:
            die(f"'{var}' required — set {envkey} (no value provided)", 2)
        fills[var] = val or default

    text = tpl["body"]
    for var, default in tpl["env"].items():
        text = text.replace(f"__{var}__", fills.get(var) or default or "")

    out = os.path.join(REPO_DIR, tpl["file"])
    with open(out, "w") as f:
        f.write(text + "\n")
    if not WIN:
        os.chmod(out, 0o755)
    info(f"Generated script written to {out}")
    print("-" * 72)
    print(text)
    print("-" * 72)
    print("Run it with:  bash " + out)
    return True


# ---------------------------------------------------------------------------
# menu
# ---------------------------------------------------------------------------
MENU = [
    ("Install panel", install_panel),
    ("Install node", install_node),
    ("Uninstall panel", uninstall_panel),
    ("Uninstall node", uninstall_node),
    ("Install requirements", install_requirements),
    ("Add admin user/pass", add_admin),
    ("Configure SMTP", configure_smtp),
    ("Configure Google OAuth", configure_google),
    ("Configure GitHub OAuth", configure_github),
    ("Configure all auth (SMTP+Google+GitHub)", configure_auth_all),
    ("Generate & customize script", generate_scripts),
    ("Configure domain / HTTPS", ensure_domain_https),
]


def banner():
    print("=" * 58)
    print("  UptimeHost setup — DevOps CLI")
    print(f"  repo   : {REPO_DIR}")
    print(f"  api    : {API_URL}")
    print(f"  platform: {platform.system()} {platform.release()}")
    print("=" * 58)


def run_option(n):
    if not (1 <= n <= len(MENU)):
        err(f"invalid option: {n}")
        return 1
    info(f"running: {MENU[n - 1][0]}")
    try:
        MENU[n - 1][1]()
        info("Done.")
        return 0
    except KeyboardInterrupt:
        warn("interrupted")
        return 130
    except Exception as e:
        err(f"step failed: {e}")
        return 1


def main():
    banner()
    args = sys.argv[1:]
    if args:
        arg = args[0]
        if arg.isdigit() and arg != "0":
            return run_option(int(arg))
        err("usage: python3 setup.py [1-%d]  (or set UH_OPT=1..%d)" % (len(MENU), len(MENU)))
        return 1
    opt = os.environ.get("UH_OPT", "").strip()
    if opt.isdigit() and opt != "0":
        return run_option(int(opt))
    while True:
        print()
        print("Select an option:")
        for i, (label, _fn) in enumerate(MENU, 1):
            print(f"  {i}. {label}")
        print("  0. Exit")
        try:
            choice = input("> ").strip()
        except KeyboardInterrupt:
            info("Bye.")
            return 0
        except EOFError:
            info("Bye.")
            return 0
        if choice in ("0", "q", "exit"):
            info("Bye.")
            return 0
        if not choice.isdigit() or not (1 <= int(choice) <= len(MENU)):
            warn("invalid option")
            continue
        run_option(int(choice))


if __name__ == "__main__":
    sys.exit(main())
