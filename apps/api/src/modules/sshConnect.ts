// AutoNodeConnect — provision + enroll a node entirely over SSH.
//
// Given an SSH host, username + password, the panel:
//   1. Connects and probes the remote for OS, CPU, RAM, disk, docker, systemd.
//   2. Uploads the prebuilt node agent binary (services/agent/bin/uh-agent).
//   3. Writes an env file + systemd unit, then starts the agent.
//   4. The agent calls back to /api/nodes/register and the node goes online.
//
// The SSH password is used transiently for the provisioning session only and is
// NEVER persisted to the database, logs or audit trail.
import { Client } from 'ssh2'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface SshCreds {
  host: string
  port: number
  username: string
  password: string
}

export interface NodeProbe {
  os: string
  arch: string
  cpuCores: number
  totalRamMb: number
  availRamMb: number
  totalDiskGb: number
  freeDiskGb: number
  dockerInstalled: boolean
  systemd: boolean
  root: boolean
}

export interface RunResult {
  code: number
  out: string
}

// Locate the prebuilt agent binary to upload. Prefer an explicit env override,
// then known repo-relative paths.
function resolveAgentBin(): string {
  const candidates: string[] = []
  if (process.env.UH_AGENT_BIN) candidates.push(process.env.UH_AGENT_BIN)
  try {
    const here = fileURLToPath(new URL('.', import.meta.url)) // …/apps/api/src/modules/
    candidates.push(`${here}../../../../services/agent/bin/uh-agent`)
    candidates.push(`${here}../../../services/agent/bin/uh-agent`)
  } catch { /* cwd-based candidates below still apply */ }
  candidates.push('/root/uptimehost/services/agent/bin/uh-agent')
  candidates.push('./services/agent/bin/uh-agent')
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return candidates.find(Boolean) || '/usr/local/bin/uh-agent'
}

function stringifyErr(e: any): string {
  if (!e) return String(e)
  const m = String(e && e.message ? e.message : e)
  // ssh2 auth failures surface as short connection errors; make them human.
  if (/auth|authentic|permission denied/i.test(m)) return `Authentication failed (check username/password) — ${m}`
  if (/timed? ?out|refused|resolve/i.test(m)) return `Could not connect (${m})`
  return m
}

// Wire up authentication. Servers commonly expose keyboard-interactive (with
// password) or plain "password" auth; ssh2 needs `tryKeyboard` and a responder
// for the former. We try whichever the server offers. Returns the connect opts.
function attachAuth(conn: any, creds: SshCreds): any {
  conn.on('keyboard-interactive', (_n: any, _i: any, _l: any, prompts: any, respond: any) => {
    try { respond((prompts || []).map(() => creds.password)) } catch { /* ignore */ }
  })
  return {
    host: creds.host,
    port: creds.port || 22,
    username: creds.username,
    password: creds.password,
    tryKeyboard: true,
  }
}

// Run a single remote command to completion. Returns exit code + combined output.
export async function sshRun(creds: SshCreds, cmd: string, opts: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const conn = new Client()
    let out = ''
    let done = false
    let timer: any = null
    const finish = (code: number, extra = '') => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { conn.end() } catch { /* ignore */ }
      resolve({ code, out: (out + extra).trim() })
    }
    if (opts.timeoutMs) timer = setTimeout(() => finish(-1, '\n[SSH TIMEOUT]'), opts.timeoutMs)
    conn.on('error', (err) => finish(-3, `\n[SSH ERROR] ${stringifyErr(err)}`))
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) return finish(-2, `\n[EXEC ERROR] ${stringifyErr(err)}`)
        stream.on('data', (d: any) => { out += d })
        stream.stderr.on('data', (d: any) => { out += d })
        stream.on('close', (code: any) => finish(typeof code === 'number' ? code : code ? 1 : 0))
      })
    })
    try {
      conn.connect(attachAuth(conn, creds))
    } catch (e) {
      finish(-4, `\n[CONNECT ERROR] ${stringifyErr(e)}`)
    }
  })
}

// Upload a local file to the remote host via SFTP (mode 0o755 so the agent is
// executable after `install` moves it into place).
export async function sshUpload(creds: SshCreds, localPath: string, remotePath: string): Promise<void> {
  const data = readFileSync(localPath)
  await new Promise<void>((resolve, reject) => {
    const conn = new Client()
    let done = false
    const finish = (err?: any) => {
      if (done) return
      done = true
      try { conn.end() } catch { /* ignore */ }
      if (err) reject(new Error(stringifyErr(err)))
      else resolve()
    }
    conn.on('error', (err) => finish(err))
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) return finish(err)
        sftp.writeFile(remotePath, data, { encoding: 'binary', mode: 0o755, flag: 'w' }, (werr: any) => finish(werr))
      })
    })
    try {
      conn.connect(attachAuth(conn, creds))
    } catch (e) {
      finish(e)
    }
  })
}

// Probe the remote for the essentials the resource form needs.
export async function sshProbe(creds: SshCreds): Promise<NodeProbe> {
  const script =
    `set -e
OS=$( { . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; } || uname -s )
printf 'OS:%s\\n' "$OS"
printf 'ARCH:%s\\n' "$(uname -m)"
printf 'CPU_CORES:%s\\n' "$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1)"
printf 'RAM_TOTAL_MB:%s\\n' "$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
printf 'RAM_AVAIL_MB:%s\\n' "$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
printf 'DISK_TOTAL_GB:%s\\n' "$(df -k / | awk 'NR==2{print int($2/1024/1024)}' 2>/dev/null || echo 0)"
printf 'DISK_FREE_GB:%s\\n' "$(df -k / | awk 'NR==2{print int($4/1024/1024)}' 2>/dev/null || echo 0)"
printf 'DOCKER:%s\\n' "$(command -v docker >/dev/null 2>&1 && docker --version 2>/dev/null || echo missing)"
printf 'SYSTEMD:%s\\n' "$(command -v systemctl >/dev/null 2>&1 && echo yes || echo no)"
printf 'ROOT:%s\\n' "$([ "$(id -u)" = "0" ] && echo yes || echo no)"
`
  const r = await sshRun(creds, script, { timeoutMs: 20000 })
  if (r.code !== 0) throw new Error(`probe failed (exit ${r.code}): ${r.out.slice(-400)}`)
  const o = r.out
  const kv = (k: string, d = '') => {
    const m = o.match(new RegExp(`^${k}:(.*)$`, 'm'))
    return m ? m[1].trim() : d
  }
  const num = (s: string) => { const n = Number(s); return Number.isFinite(n) ? n : 0 }
  return {
    os: kv('OS', creds.host),
    arch: kv('ARCH'),
    cpuCores: num(kv('CPU_CORES')),
    totalRamMb: num(kv('RAM_TOTAL_MB')),
    availRamMb: num(kv('RAM_AVAIL_MB')),
    totalDiskGb: num(kv('DISK_TOTAL_GB')),
    freeDiskGb: num(kv('DISK_FREE_GB')),
    dockerInstalled: kv('DOCKER') !== 'missing',
    systemd: kv('SYSTEMD') === 'yes',
    root: kv('ROOT') === 'yes',
  }
}

export interface SshInstallSpec {
  nodeId: string
  nodeName: string
  agentToken: string
  regToken: string
  registerUrl: string // panel /api/nodes/register (reachable from the node)
  host: string // advertised host the panel should use to reach the agent
  listenPort: number // agent listen port (7373)
  scheme?: 'http' | 'https'
}

// Install + start the node agent on the remote. Binary is uploaded first, then a
// single bash script provisions env + systemd unit and starts the agent.
export async function sshInstall(creds: SshCreds, spec: SshInstallSpec): Promise<string> {
  const bin = resolveAgentBin()
  if (!existsSync(bin)) throw new Error(`Agent binary not found (${bin}) — set UH_AGENT_BIN`)

  // 1) Upload binary to a world-writable staging path, then `install` moves it.
  await sshUpload(creds, bin, '/tmp/uh-agent')

  const port = spec.listenPort
  const scheme = spec.scheme || 'http'
  const env: string[] = [
    `UH_CORE_URL=${spec.registerUrl}`,
    `UH_NODE_ID=${spec.nodeId}`,
    `UH_REG_TOKEN=${spec.regToken}`,
    `UH_AGENT_ADDR=0.0.0.0:${port}`,
    `UH_AGENT_TOKEN=${spec.agentToken}`,
    `UH_AGENT_SCHEME=${scheme}`,
    `UH_AGENT_HOST=${spec.host}`,
    `UH_CONTAINER_BASE=/var/lib/uptimehost/data`,
    `UH_POLL_INTERVAL=5`,
  ]

  const script = [
    `set -e`,
    `SUDO=""`,
    `[ "$(id -u)" = "0" ] || SUDO="sudo -n"`,
    `if [ -n "$SUDO" ]; then $SUDO true 2>/dev/null || { echo "[UH] needs root or passwordless sudo"; exit 9; }; fi`,
    `$SUDO mkdir -p /etc/uptimehost /var/lib/uptimehost/data`,
    `$SUDO install -m 0755 /tmp/uh-agent /usr/local/bin/uh-agent`,
    `rm -f /tmp/uh-agent`,
    `if ! command -v docker >/dev/null 2>&1; then`,
    `  echo "[UH] installing docker..."`,
    `  if command -v apt-get >/dev/null 2>&1; then`,
    `    export DEBIAN_FRONTEND=noninteractive`,
    `    $SUDO apt-get update -y >/dev/null 2>&1 || true`,
    `    $SUDO apt-get install -y docker.io >/dev/null 2>&1 || $SUDO apt-get install -y docker-ce >/dev/null 2>&1 || true`,
    `  elif command -v dnf >/dev/null 2>&1; then`,
    `    $SUDO dnf install -y docker >/dev/null 2>&1 || true`,
    `  elif command -v yum >/dev/null 2>&1; then`,
    `    $SUDO yum install -y docker >/dev/null 2>&1 || true`,
    `  fi`,
    `fi`,
    `docker --version >/dev/null 2>&1 || echo "[UH] WARN docker not confirmed; agent will start and retry"`,
    `cat > /tmp/agent.env <<'ENV'`,
    ...env,
    `ENV`,
    `$SUDO install -m 0600 /tmp/agent.env /etc/uptimehost/agent.env`,
    `rm -f /tmp/agent.env`,
    `if command -v systemctl >/dev/null 2>&1; then`,
    `  cat > /tmp/uh-agent.service <<'SVC'`,
    `[Unit]`,
    `Description=UptimeHost Node Agent (${spec.nodeName})`,
    `After=network-online.target docker.service`,
    `Wants=network-online.target`,
    `[Service]`,
    `Type=simple`,
    `EnvironmentFile=/etc/uptimehost/agent.env`,
    `ExecStart=/usr/local/bin/uh-agent`,
    `Restart=always`,
    `RestartSec=3`,
    `[Install]`,
    `WantedBy=multi-user.target`,
    `SVC`,
    `  $SUDO install -m 0644 /tmp/uh-agent.service /etc/systemd/system/uh-agent.service`,
    `  rm -f /tmp/uh-agent.service`,
    `  $SUDO systemctl daemon-reload`,
    `  $SUDO systemctl enable uh-agent >/dev/null 2>&1 || true`,
    `  $SUDO systemctl restart uh-agent`,
    `else`,
    `  pkill -f uh-agent >/dev/null 2>&1 || true`,
    `  nohup /bin/sh -c '. /etc/uptimehost/agent.env; exec /usr/local/bin/uh-agent' >/var/log/uh-agent.log 2>&1 &`,
    `fi`,
    `echo "UH-NODE-OK node=${spec.nodeId} scheme=${scheme} host=${spec.host} port=${port}"`,
  ].join('\n')

  const r = await sshRun(creds, script, { timeoutMs: 180000 })
  if (r.code !== 0) throw new Error(`Remote install failed (exit ${r.code}): ${r.out.slice(-800)}`)
  if (!/UH-NODE-OK/.test(r.out)) throw new Error(`Remote install did not confirm: ${r.out.slice(-400)}`)
  return r.out
}