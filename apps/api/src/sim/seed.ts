// Seeds only non-infrastructure content. The panel starts empty: the operator
// must create nodes and servers themselves. Blueprints are the deployable
// catalog (the "egg" equivalent) the operator picks from when creating servers.
import type { Store } from '../store/store.js'
import crypto from 'node:crypto'

export function seed(store: Store) {
  const db = store.db
  let changed = false

  // Never ship a static credential. A fresh/empty DB gets a random owner
  // password, printed exactly once to the operator console. The automated
  // bootstrapper (setup.py) may instead seed a predetermined secret via
  // UH_ADMIN_PASSWORD / UH_ADMIN_EMAIL / UH_ADMIN_NAME so the one-liner install
  // can remain fully unattended. Existing panels (users already present) are
  // never re-seeded or re-created, and an existing value is never overwritten.
  if (db.users.length === 0) {
    const envPass = process.env.UH_ADMIN_PASSWORD || ''
    const seedPass = envPass || crypto.randomBytes(24).toString('base64url')
    db.users.push({
      id: 'u-admin',
      email: (process.env.UH_ADMIN_EMAIL || 'admin@uptime.host').trim().toLowerCase() || 'admin@uptime.host',
      name: process.env.UH_ADMIN_NAME || 'Avery Stone',
      role: 'owner',
      avatarHue: 214,
      passwordHash: hashPw(seedPass),
      createdAt: Date.now(),
    })
    // Only print a generated secret; an env-provided one is owned by the
    // operator (setup.py prints it once itself). Never log it to disk.
    if (!envPass) {
      console.log(`\n[seed] created initial owner account  ${db.users[0].email} / ${seedPass}`)
      console.log('[seed] store this password now — it is shown only once.\n')
    }
    changed = true
  }

  if (db.blueprints.length === 0) {
    const bp = (
      id: string, name: string, category: string, image: string, startup: string,
      stop: string, env: Record<string, string>, ports: number[],
      cpu: number, mem: number, disk: number,
    ) => ({
      id, name, category, image, startup, stop, environment: env, ports,
      recommendedCpu: cpu, recommendedMemoryMb: mem, recommendedStorageGb: disk, version: 1,
    })

    db.blueprints.push(
      // Minecraft catalog blueprints are version-aware: the image and startup are
      // resolved per-server from the Mojang version manifest at creation time, so
      // the image here is only a sensible fallback. Vanilla downloads Mojang's
      // server.jar; Paper downloads the matching PaperMC build.
      bp('bp-minecraft', 'Minecraft Java', 'Game', 'ghcr.io/pterodactyl/yolks:java_21', 'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar server.jar nogui', 'stop', { EULA: 'TRUE' }, [25565], 200, 4096, 10),
      bp('bp-paper', 'Minecraft Paper', 'Game', 'ghcr.io/pterodactyl/yolks:java_21', 'java -Xms128M -XX:MaxRAMPercentage=95.0 -jar server.jar nogui', 'stop', { EULA: 'TRUE' }, [25565], 250, 6144, 15),
      bp('bp-node', 'Node.js App', 'Application', 'node:20-bookworm', 'node server.js', 'SIGTERM', { NODE_ENV: 'production', PORT: '3000' }, [3000], 100, 1024, 5),
      bp('bp-postgres', 'PostgreSQL', 'Database', 'postgres:16', 'postgres', 'fast', { POSTGRES_PASSWORD: '{{DB_PASSWORD}}' }, [5432], 150, 2048, 20),
      bp('bp-terraria', 'Terraria', 'Game', 'ghcr.io/parkervcp/yolks:terraria_1449', './TerrariaServer -config serverconfig.txt', 'exit', {}, [7777], 200, 3072, 8),
      bp('bp-valheim', 'Valheim', 'Game', 'ghcr.io/parkervcp/yolks:valheim', './start_server.sh', 'stop', {}, [2456], 250, 4096, 15),
    )
    changed = true
  }

  if (changed) store.persist()
}

export function hashPw(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPw(pw: string, stored: string | null | undefined): boolean {
  if (!stored) return false
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const test = crypto.scryptSync(pw, salt, 64).toString('hex')
  return hash === test
}
