# UptimeHost Architecture

> Infrastructure that stays alive.

## Overview

UptimeHost is a next-generation server infrastructure management platform. Its
core philosophy is **Visibility, Diagnostics, Observability, Reliability, and
Developer Experience** — not just START/STOP/RESTART buttons.

## Monorepo Layout

```
uptimehost/
├── apps/
│   ├── web/          # React + Vite + TypeScript SPA (frontend)
│   └── api/          # Fastify REST API + WebSocket gateway (backend)
├── packages/
│   ├── shared/       # Shared domain logic & utilities
│   └── types/        # Shared TypeScript types (API contracts, entities)
├── services/         # Modular service contractors (agents in production: Go)
├── infrastructure/   # Docker / compose deployment
└── docs/
```

## Backend (apps/api)

- **Fastify** HTTP server exposing a versioned REST API.
- **@fastify/websocket** gateway for real-time events (terminal, status, metrics).
- **In-memory + JSON-file persistence** (swappable persistence adapter; the
  schema is documented for PostgreSQL/Redis in production).
- Modules: `auth`, `orgs`, `nodes`, `services`, `terminal`, `metrics`,
  `diagnostics`, `automation`, `snapshots`, `access`, `alerts`, `audit`, `api-keys`.

### Concurrency model
- A WebSocket connection multiplexes subscriptions. Clients subscribe by topic.
- Terminal streams are broadcast per-service with FIFO ring buffers.

## Real-time architecture
WebSockets carry: terminal output, service status, resource metrics, deployment
progress, infrastructure events, and notifications. No polling needed.

## Security
- PBKDF2 password hashing.
- Session tokens (opaque, persisted).
- API key authentication for programmatic access.
- Backend-enforced authorization on every endpoint (never rely on the frontend).
- Audit logging for every mutating action.
- Rate limiting on auth endpoints.

## Frontend (apps/web)
- React 18 + Vite + TypeScript.
- Tailwind CSS + CSS variables for a dual dark/light theming system.
- Original navigation: **top command bar + adaptive rail + workspace modes**.
- WebSocket client with reconnect + event dispatch.
- Command center (Ctrl+K), global search, activity stream, notifications.

## Workspace modes
Every service opens into a **Workspace** with functional modes:
1. **LIVE** — status, uptime, live activity, resource bars, alerts
2. **TERMINAL** — streaming console, ANSI colors, search/filter, signal panel
3. **OBSERVE** — interactive metrics with event correlation
4. **DIAGNOSE** — the Diagnostic Engine
5. **EXPLORE** — workspace file explorer + code environment
6. **AUTOMATE** — automation flows
7. **SNAPSHOTS** — restore points
8. **ACCESS** — access map & granular permissions

## Infrastructure
- **Infrastructure Map**: visual network of Control Core + nodes.
- **Node Workspace**: health, capacity, activity, diagnostics, health checks.
- **Launch Service** wizard: SELECT → BUILD → POWER → CONNECT → LAUNCH.
- **Blueprints**: versioned deployment templates.

## Node Agent
In production the agent is a **Go** daemon managing Docker containers, resource
stats, file ops, and snapshots, communicating securely with the Control Core
over TLS with token auth. A reference simulation is included in `services/agent`.
