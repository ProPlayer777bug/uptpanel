// In-memory store with JSON-file persistence.
// In production this adapter is replaced by PostgreSQL + Redis.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DBShape {
  users: any[]
  sessions: any[]
  locations: any[]
  nodes: any[]
  servers: any[]
  blueprints: any[]
  terminal: Record<string, any[]>
  signals: any[]
  metrics: Record<string, any[]>
  events: any[]
  diagnostics: any[]
  flows: any[]
  snapshots: any[]
  access: any[]
  audit: any[]
  notifications: any[]
  alerts: any[]
  apiKeys: any[]
  activity: any[]
  orgs: any[]
  invocations: Record<string, any[]>
  backups: any[]
  schedules: any[]
  scheduleRuns: any[]
  databases: any[]
  settings: Record<string, any>
  otp: any[]
}

export function freshDb(): DBShape {
  return {
    users: [],
    sessions: [],
    locations: [],
    nodes: [],
    servers: [],
    blueprints: [],
    terminal: {},
    signals: [],
    metrics: {},
    events: [],
    diagnostics: [],
    flows: [],
    snapshots: [],
    access: [],
    audit: [],
    notifications: [],
    alerts: [],
    apiKeys: [],
    activity: [],
    orgs: [],
    invocations: {},
    backups: [],
    schedules: [],
    scheduleRuns: [],
    databases: [],
    settings: {},
    otp: [],
  }
}

const FILE = process.env.UH_DB_FILE || './.uh-data/db.json'

export class Store {
  db: DBShape

  constructor() {
    if (existsSync(FILE)) {
      try {
        this.db = { ...freshDb(), ...(JSON.parse(readFileSync(FILE, 'utf8')) as DBShape) }
        return
      } catch {
        /* fall through to fresh */
      }
    }
    this.db = freshDb()
    this.persist()
  }

  persist() {
    try {
      mkdirSync(dirname(FILE), { recursive: true })
      const tmp = `${FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(this.db, null, 2))
      // The DB holds hashed passwords, tokens and SMTP/OAuth secrets — keep it
      // owner-only so other local users/processes cannot read it.
      chmodSync(tmp, 0o600)
      renameSync(tmp, FILE)
    } catch {
      /* non-fatal */
    }
  }
}
