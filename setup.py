#!/usr/bin/env python3
"""
UptimeHost setup — DevOps CLI
============================

Cross-platform (Linux / macOS / Windows) numbered menu that provisions and
operates the UptimeHost control plane on the current machine.

    [1] Install panel        install requirements, build the web bundle, and
                             start the API + web services in the background.
    [2] Install node         build the Go node agent and run it in the
                             background against the panel.
    [3] Uninstall panel      stop the panel API + web services and remove the
                             built web bundle.
    [4] Uninstall node       stop the node agent.
    [5] Install requirements install npm + Go dependencies and build the agent.
    [6] Add admin user/pass  log into the panel API as an existing admin and
                             provision a new administrator account.

Uses only the Python standard library. On POSIX systems it daemonizes service
processes with their own session; on Windows it uses CREATE_NEW_PROCESS_GROUP.

Environment overrides (all optional):
    UH_REPO_DIR    path to the UptimeHost checkout (default: setup.py parent)
    UH_API_URL     panel API base URL, e.g. http://panel.example.com:8081
                   (default: http://localhost:8081)
    UH_WEB_PORT    web dev-server port (default: 8080)
    UH_API_PORT    API port (default: 8081)
"""

import getpass
import json
import os
import platform
import shutil
import subprocess
import sys
import time
import urllib.request
import urllib.error

APP_NAME = "uptimehost"

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


def pid_file(name):
    return os.path.join(REPO_DIR, f".{name}.pid")


def log_file(name):
    return os.path.join(REPO_DIR, f"{name}.log")


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


# ---------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------
def install_requirements():
    info("Installing requirements...")
    require("npm", "install Node.js >= 18 from https://nodejs.org")
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


def install_panel():
    info("Installing panel...")
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
    info(f"Panel started. Web: http://localhost:{WEB_PORT}  API: {API_URL}")
    return True


def install_node():
    info("Installing node agent...")
    state = load_state()
    go_dir = os.path.join(REPO_DIR, "services", "agent")
    if not os.path.exists(os.path.join(go_dir, "go.mod")):
        die("agent module not found — run this from the UptimeHost checkout root.")
    require("go")
    os.makedirs(os.path.join(go_dir, "bin"), exist_ok=True)
    code, out = sh(["go", "build", "-o", os.path.join(go_dir, "bin", "uh-agent"), "./cmd/agent"], cwd=go_dir, capture=True)
    if code != 0:
        die("agent build failed:\n" + out)
    node_id = state.get("node_id") or input("Node ID (leave blank for panel-generated): ").strip() or "node-local"
    token = state.get("agent_token") or input("Agent shared token: ").strip() or "agent-secret"
    scheme = state.get("scheme") or input("Agent scheme [http/https] (default http): ").strip() or "http"
    host = state.get("host") or input("Agent host/FQDN the panel will reach (default localhost): ").strip() or "localhost"
    addr = state.get("agent_addr") or ":7373"
    core_url = input(f"Panel API base URL [{API_URL}]: ").strip() or API_URL
    start_daemon(
        "node-agent",
        [os.path.join(go_dir, "bin", "uh-agent")],
        cwd=go_dir,
        env={
            "UH_NODE_ID": node_id,
            "UH_AGENT_TOKEN": token,
            "UH_AGENT_SCHEME": scheme,
            "UH_AGENT_HOST": host,
            "UH_AGENT_ADDR": addr,
            "UH_CORE_URL": core_url.rstrip("/") + "/api/nodes/register",
        },
    )
    state.update(node_id=node_id, agent_token=token, scheme=scheme, host=host, agent_addr=addr)
    save_state(state)
    info("Node agent started. Add this host to the panel as a node and it will self-register.")
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


def http_json(url, payload=None, token=None, method=None):
    """Tiny stdlib JSON HTTP client."""
    data = json.dumps(payload).encode() if payload is not None else None
    method = method or ("POST" if payload is not None else "GET")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
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
# menu
# ---------------------------------------------------------------------------
MENU = [
    ("Install panel", install_panel),
    ("Install node", install_node),
    ("Uninstall panel", uninstall_panel),
    ("Uninstall node", uninstall_node),
    ("Install requirements", install_requirements),
    ("Add admin user/pass", add_admin),
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
        err("usage: python3 setup.py [1-6]  (or set UH_OPT=1..6)")
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
