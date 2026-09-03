// UptimeHost shared types — API contracts and domain entities.

export type Severity = 'healthy' | 'attention' | 'warning' | 'critical'

export type ServerState =
  | 'provisioning'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'killing'
  | 'offline'
  | 'error'

export interface Session {
  token: string
  userId: string
  createdAt: number
  expiresAt: number
}

export interface User {
  id: string
  email: string
  name: string
  role: 'owner' | 'admin' | 'operator' | 'developer' | 'viewer'
  avatarHue: number
  createdAt: number
}

export interface Location {
  id: string
  name: string
  shortCode: string
  description: string
  createdAt: number
}

export type NodeScheme = 'http' | 'https'

export interface Node {
  id: string
  name: string
  locationId: string | null
  // Agent connectivity is expressed as scheme + FQDN/host + port so operators
  // can choose http or https and install the agent on any reachable machine.
  scheme: NodeScheme
  host: string
  port: number
  agentUrl: string
  agentToken: string
  registrationToken: string
  installCommand: string
  status: 'online' | 'offline' | 'unconfigured'
  dockerHealthy: boolean
  agentVersion: string | null
  memoryMb: number
  diskGb: number
  overcommit: boolean
  maintenance: boolean
  remainingMemoryMb: number
  remainingDiskGb: number
  health: { reachedAt: number; containers: number; dockerHealthy: boolean } | null
  serverCount: number
  allocatedMemoryMb: number
  allocatedDiskGb: number
  createdAt: number
}

export interface Allocation {
  id: string
  port: number
  proto: string
}

export interface Blueprint {
  id: string
  name: string
  category: string
  image: string
  startup: string
  stop: string
  environment: Record<string, string>
  ports: number[]
  recommendedCpu: number
  recommendedMemoryMb: number
  recommendedStorageGb: number
  version: number
}

export interface Server {
  id: string
  name: string
  ownerEmail?: string
  nodeId: string
  blueprintId: string
  state: ServerState
  permissions?: Record<string, boolean>
  role?: string
  cpuPercent: number
  memoryMb: number
  memoryLimitMb: number
  storageGb: number
  extraEnv: Record<string, string>
  allocations: Allocation[]
  createdAt: number
  installed: boolean
  startedAt: number | null
  lastAction?: string
  error?: string
  node?: { id: string; name: string; status: string; agentUrl: string } | null
  blueprint?: Blueprint | null
}

export interface TerminalLine {
  id: string
  serverId: string
  ts: number
  text: string
  level: 'info' | 'warn' | 'error' | 'plain'
}

export interface Signal {
  id: string
  serverId: string
  severity: Severity
  title: string
  detail: string
  count: number
  firstTs: number
  lastTs: number
}

export interface MetricPoint {
  t: number
  cpu: number
  mem: number
  disk: number
  netRx: number
  netTx: number
}

export interface MetricSeries {
  serverId: string
  range: string
  points: MetricPoint[]
}

export interface EventItem {
  id: string
  serverId: string
  ts: number
  type: string
  message: string
  actor?: string
}

export interface Diagnostic {
  id: string
  serverId: string
  severity: Severity
  title: string
  summary: string
  cause: string
  occurrences: number
  firstTs: number
  lastTs: number
  logSnippet: string
  steps: string[]
}

export interface FlowStep {
  id: string
  kind: 'trigger' | 'condition' | 'action' | 'delay'
  type: string
  config: Record<string, unknown>
}

export interface Flow {
  id: string
  serverId: string
  name: string
  enabled: boolean
  steps: FlowStep[]
  runs: number
  lastRun?: number
}

export interface Snapshot {
  id: string
  serverId: string
  name: string
  kind: 'manual' | 'automatic' | 'scheduled'
  sizeMb: number
  createdAt: number
  restoredFrom?: string
}

export interface AccessEntry {
  id: string
  serverId: string
  email: string
  role: 'owner' | 'admin' | 'operator' | 'developer' | 'viewer'
  permissions: Record<string, boolean>
  addedAt: number
}

export interface AuditRecord {
  id: string
  ts: number
  actor: string
  action: string
  target: string
  before?: unknown
  after?: unknown
}

export interface Notification {
  id: string
  type: 'critical' | 'warning' | 'info' | 'success'
  title: string
  message: string
  ts: number
  read: boolean
  serverId?: string
}

export interface AlertRule {
  id: string
  serverId: string
  metric: string
  operator: string
  threshold: number
  durationSeconds: number
  action: string
  enabled: boolean
}

export interface ApiKey {
  id: string
  name: string
  prefix: string
  permissions: string[]
  createdAt: number
  expiresAt?: number
}

export interface ActivityItem {
  id: string
  ts: number
  kind: 'service' | 'node' | 'automation' | 'snapshot' | 'user' | 'system' | 'server' | 'admin'
  severity: 'info' | 'warn' | 'error'
  message: string
  serverId?: string
  serviceId?: string
  nodeId?: string
  actor?: string
}

export interface ThemePref {
  mode: 'dark' | 'light' | 'system'
}

export type WsMessage =
  | { type: 'terminal-line'; data: TerminalLine }
  | { type: 'server-update'; data: Server }
  | { type: 'metric-point'; data: MetricPoint }
  | { type: 'service-event'; data: EventItem }
  | { type: 'deploy-progress'; data: { serverId: string; pct: number; stage: string } }
  | { type: 'notification'; data: Notification }
  | { type: 'activity'; data: ActivityItem }
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'diagnostic'; data: Diagnostic }
  | { type: 'backup-progress'; data: any }
  | { type: 'schedule-update'; data: any }
  | { type: 'schedule-run'; data: any }
