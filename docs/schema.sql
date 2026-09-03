-- UptimeHost production schema (PostgreSQL reference).
-- The reference backend ships with an in-memory + JSON adapter; this schema
-- is the target persistence layer for a production deployment.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer',
  password_hash text NOT NULL,
  avatar_hue    int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE organizations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL
);

CREATE TABLE memberships (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id         uuid REFERENCES teams(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'viewer'
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE nodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  location          text,
  status            text NOT NULL DEFAULT 'healthy',
  agent_connected   boolean NOT NULL DEFAULT false,
  docker_healthy    boolean NOT NULL DEFAULT false,
  total_cpu         int NOT NULL DEFAULT 0,
  total_memory_mb   int NOT NULL DEFAULT 0,
  total_storage_gb  int NOT NULL DEFAULT 0,
  last_seen         timestamptz
);

CREATE TABLE blueprints (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  category             text,
  image                text NOT NULL,
  startup              text,
  stop                 text,
  environment          jsonb NOT NULL DEFAULT '{}',
  ports                int[] NOT NULL DEFAULT '{}',
  recommended_cpu      int,
  recommended_memory_mb int,
  recommended_storage_gb int,
  version              int NOT NULL DEFAULT 1
);

CREATE TABLE allocations (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host      text NOT NULL,
  port      int NOT NULL,
  node_id   uuid REFERENCES nodes(id) ON DELETE SET NULL,
  service_id uuid REFERENCES services(id) ON DELETE CASCADE,
  UNIQUE (host, port)
);

CREATE TABLE services (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  node_id        uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  blueprint_id   uuid REFERENCES blueprints(id),
  state          text NOT NULL DEFAULT 'PROVISIONING',
  cpu_limit      int NOT NULL DEFAULT 200,
  memory_limit_mb int NOT NULL DEFAULT 2048,
  storage_gb     int NOT NULL DEFAULT 10,
  container_id   text,
  started_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_services_node ON services(node_id);
CREATE INDEX idx_services_state ON services(state);

CREATE TABLE terminal_lines (
  id         bigserial PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  text       text NOT NULL,
  level      text NOT NULL DEFAULT 'plain'
);
CREATE INDEX idx_terminal_service_ts ON terminal_lines(service_id, ts);

CREATE TABLE metrics (
  id         bigserial PRIMARY KEY,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  cpu        real, mem real, disk real, net_rx real, net_tx real
);
CREATE INDEX idx_metrics_service_ts ON metrics(service_id, ts);

CREATE TABLE events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES services(id) ON DELETE CASCADE,
  node_id    uuid REFERENCES nodes(id) ON DELETE CASCADE,
  ts         timestamptz NOT NULL DEFAULT now(),
  type       text NOT NULL,
  message    text NOT NULL,
  actor      text
);
CREATE INDEX idx_events_service_ts ON events(service_id, ts);

CREATE TABLE diagnostics (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid REFERENCES services(id) ON DELETE CASCADE,
  severity    text NOT NULL,
  title       text NOT NULL,
  summary     text,
  cause       text,
  occurrences int NOT NULL DEFAULT 1,
  first_ts    timestamptz,
  last_ts     timestamptz,
  log_snippet text,
  steps       jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_diag_service ON diagnostics(service_id, severity);

CREATE TABLE flows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid REFERENCES services(id) ON DELETE CASCADE,
  name       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  steps      jsonb NOT NULL DEFAULT '[]',
  runs       int NOT NULL DEFAULT 0,
  last_run   timestamptz
);

CREATE TABLE snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'manual',
  size_mb     int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE access_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}',
  added_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id       uuid REFERENCES services(id) ON DELETE CASCADE,
  metric           text NOT NULL,
  operator         text NOT NULL,
  threshold        real NOT NULL,
  duration_seconds int NOT NULL DEFAULT 0,
  action           text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true
);

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  prefix      text NOT NULL,
  secret_hash text NOT NULL,
  permissions text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz
);

CREATE TABLE audit_trail (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  before  jsonb,
  after   jsonb
);
CREATE INDEX idx_audit_ts ON audit_trail(ts);

CREATE TABLE activity (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,
  severity   text NOT NULL,
  message    text NOT NULL,
  service_id uuid REFERENCES services(id) ON DELETE CASCADE,
  node_id    uuid REFERENCES nodes(id) ON DELETE CASCADE,
  actor      text
);
CREATE INDEX idx_activity_ts ON activity(ts);
