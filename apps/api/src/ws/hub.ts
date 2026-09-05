// WebSocket hub — multiplexes subscriptions and broadcasts events.
import type { WebSocket } from 'ws'
import type { WsMessage } from '@uptimehost/types'

interface Client {
  ws: WebSocket
  topics: Set<string>
  user?: any | null
}

export class WsHub {
  private clients = new Set<Client>()

  // authorize(user, topic) gates whether a client may receive a given topic.
  // Used to scope 'srv:*' streams to users with server access (no data spill
  // into the default 'all' subscription). Return true to allow.
  constructor(private authorize: (user: any | null, topic: string) => boolean) {}

  add(ws: WebSocket, user?: any | null): Client {
    const c: Client = { ws, topics: new Set(['all']), user: user ?? null }
    this.clients.add(c)
    return c
  }

  remove(c: Client) {
    this.clients.delete(c)
  }

  subscribe(c: Client, topic: string) {
    // Never let a client subscribe to a topic they are not authorized to read.
    if (!this.authorize(c.user, topic)) return
    c.topics.add(topic)
  }

  unsubscribe(c: Client, topic: string) {
    c.topics.delete(topic)
  }

  private canReceive(c: Client, topic: string): boolean {
    return this.authorize(c.user, topic)
  }

  broadcast(msg: WsMessage, topic?: string) {
    const data = JSON.stringify(msg)
    for (const c of this.clients) {
      if (!c.topics.has('all')) continue
      if (topic && !c.topics.has(topic)) continue
      if (c.topics.has('all') || c.topics.has(topic || '')) {
        if (!this.canReceive(c, topic || '')) continue
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(data)
      }
    }
  }

  to(topic: string, msg: WsMessage) {
    const data = JSON.stringify(msg)
    for (const c of this.clients) {
      if (c.topics.has(topic) || c.topics.has('all')) {
        if (!this.canReceive(c, topic)) continue
        if (c.ws.readyState === c.ws.OPEN) c.ws.send(data)
      }
    }
  }

  // Scoped live activity: only deliver to clients whose user passes canSee.
  broadcastActivity(item: any, canSee: (user: any) => boolean) {
    const data = JSON.stringify({ type: 'activity', data: item })
    for (const c of this.clients) {
      if (c.ws.readyState !== c.ws.OPEN) continue
      if (!c.topics.has('all') && !c.topics.has('activity')) continue
      if (canSee(c.user)) c.ws.send(data)
    }
  }
}