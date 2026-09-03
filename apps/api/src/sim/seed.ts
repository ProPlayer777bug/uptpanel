// Seeds only non-infrastructure content. The panel starts empty: the operator
// must create nodes and servers themselves. Blueprints are the deployable
// catalog (the "egg" equivalent) the operator picks from when creating servers.
import type { Store } from '../store/store.js'
import { nanoid } from 'nanoid'
import crypto from 'node:crypto'

export function seed(store: Store) {
  const db = store.db
  if (db.users.length > 0 && db.blueprints.length > 0) return

  db.users.push({
    id: 'u-admin',
    email: 'admin@uptime.host',
    name: 'Avery Stone',
    role: 'owner',
    avatarHue: 214,
    passwordHash: hashPw('admin123'),
    createdAt: Date.now(),
  })

  const bp = (
    id: string, name: string, category: string, image: string, startup: string,
    stop: string, env: Record<string, string>, ports: number[],
    cpu: number, mem: number, disk: number,
  ) => ({
    id, name, category, image, startup, stop, environment: env, ports,
    recommendedCpu: cpu, recommendedMemoryMb: mem, recommendedStorageGb: disk, version: 1,
  })

  db.blueprints.push(
    bp('bp-minecraft', 'Minecraft Java', 'Game', 'itzg/minecraft-server:java21', '{{JAVA_OPTS}} -jar server.jar nogui', 'stop', { EULA: 'TRUE', MEMORY: '2G', TYPE: 'VANILLA' }, [25565], 200, 4096, 10),
    bp('bp-paper', 'Minecraft Paper', 'Game', 'ghcr.io/pterodactyl/yolks:java_21', 'java -Xms{{MEM_MIN}}M -Xmx{{MEM_MAX}}M -jar server.jar nogui', 'stop', { EULA: 'TRUE' }, [25565], 250, 6144, 15),
    bp('bp-node', 'Node.js App', 'Application', 'node:20-bookworm', 'node server.js', 'SIGTERM', { NODE_ENV: 'production', PORT: '3000' }, [3000], 100, 1024, 5),
    bp('bp-postgres', 'PostgreSQL', 'Database', 'postgres:16', 'postgres', 'fast', { POSTGRES_PASSWORD: '{{DB_PASSWORD}}' }, [5432], 150, 2048, 20),
    bp('bp-terraria', 'Terraria', 'Game', 'ghcr.io/parkervcp/yolks:terraria_1449', './TerrariaServer -config serverconfig.txt', 'exit', {}, [7777], 200, 3072, 8),
    bp('bp-valheim', 'Valheim', 'Game', 'ghcr.io/parkervcp/yolks:valheim', './start_server.sh', 'stop', {}, [2456], 250, 4096, 15),
  )

  store.persist()
}

export function hashPw(pw: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPw(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const test = crypto.scryptSync(pw, salt, 64).toString('hex')
  return hash === test
}
