# ⚡ UptimeHost

> **Infrastructure that stays alive.**

UptimeHost is a next-generation server infrastructure management platform. It is
an **original** product — built around live **infrastructure workspaces**, deep
**diagnostics**, real-time **observability**, event **correlation**, and
**automation flows** — not a traditional START/STOP/RESTART hosting panel.

## What's inside

Everything runs with real functionality — a live backend that streams real-time
telemetry over WebSockets and a React frontend that renders it live.

| Layer | Path | Stack |
|------|------|-------|
| Frontend | `apps/web` | React + TypeScript + Vite + Tailwind-style custom CSS |
| Backend | `apps/api` | Fastify + WebSockets (REST + real-time) |
| Shared types | `packages/types` | API contracts used by both |
| Node Agent (reference) | `services/agent` | Go modular agent |
| Docs | `docs` | Architecture, DB schema |

## Quick start

Prerequisites: Node 18+ and npm.

```bash
# Terminal 1 — backend (Control Core)
cd apps/api
npm install
npm run dev          # http://localhost:8787  (REST + WebSocket gateway)

# Terminal 2 — frontend
cd apps/web
npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173 and sign in with the demo account:

```
admin@uptime.host / admin123
```

The Vite dev server proxies `/api` and `/ws` to the backend, so everything works
out of the box. Data persists to `apps/api/.uh-data/db.json` (an in-memory +
JSON adapter; a production PostgreSQL schema lives in `docs/schema.sql`).

## What you can do

- **Dashboard** — live System Health with current signals.
- **Infrastructure Map** — original visual network of the Control Core + nodes.
- **Infrastructure Workspaces** — every service opens into a live workspace:
  1. **LIVE** — status, uptime, real-time resource bars.
  2. **TERMINAL** — streaming console with ANSI colors, search, regex filter,
     pause, log download, and an automatic **Signal Panel** (errors/warnings).
  3. **OBSERVE** — interactive metrics with time ranges and **event correlation**
     (click a spike → see the surrounding events).
  4. **DIAGNOSE** — the Diagnostic Engine with a severity system and
     **Open Investigation** timeline.
  5. **EXPLORE** — workspace file explorer + code environment with tabs,
     JSON validation, and a problems panel.
  6. **AUTOMATE** — visual automation flows (triggers → conditions → delays →
     actions).
  7. **SNAPSHOTS** — restore points with storage visualization.
  8. **ACCESS** — granular access map with backend-enforced permissions.
- **Launch Service** wizard (SELECT → BUILD → POWER → CONNECT → LAUNCH) with a
  live deployment progress screen.
- **Global Command Center** (`Ctrl+K`) to search servers, run actions, and
  navigate.
- **Notifications**, global **Activity Stream**, **Audit Trail**, and full
  **dark / light / system** themes.

## Architecture

- **Real-time**: a WebSocket gateway multiplexes terminal output, service
  status, metrics, deployment progress, infrastructure events, and
  notifications. No polling.
- **Security**: PBKDF2 password hashing, server sessions, backend-enforced
  authorization on every endpoint, audit logging, rate limiting.
- **Node Agent** (Go): modular agent managing Docker, containers, stats, files,
  ports, and snapshots, talking to the Control Core over an authenticated TLS
  WebSocket.

See `docs/ARCHITECTURE.md` for details, and `docs/schema.sql` for the
production PostgreSQL schema (PostgreSQL + Redis are the production data
stores behind the bundled in-memory adapter).

## Demonstration grading note

The reference backend simulates the agent/Docker layer (so the platform is fully
interactive without a real Docker/Go environment), but every feature — REST API,
WebSocket events, diagnostics, automation, deployment — is real, wired, and
testable. A headless-browser smoke suite verifies login, all 8 workspace modes,
theme switching, and the command center against the running servers.
