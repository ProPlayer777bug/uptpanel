import { useEffect, useRef, useState, useCallback } from 'react'
import type { WsMessage } from '@uptimehost/types'
import { getToken } from '../api/client'

// Global socket singleton so all views share one connection.
let socket: WebSocket | null = null
const listeners = new Set<(msg: WsMessage) => void>()
let reconnectDelay = 1000
let retries = 0

function connect(onOpen?: () => void) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const url = `${proto}://${location.host}/ws?token=${getToken()}`
  socket = new WebSocket(url)
  socket.onopen = () => {
    reconnectDelay = 1000
    retries = 0
    onOpen?.()
  }
  socket.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as WsMessage
      listeners.forEach((l) => l(msg))
    } catch {}
  }
  socket.onclose = () => {
    if (retries > 20) return
    setTimeout(() => connect(onOpen), reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 1.6, 15000)
    retries++
  }
  socket.onerror = () => {}
}

export function useSocket(onMessage?: (msg: WsMessage) => void) {
  const [connected, setConnected] = useState(false)
  const cbRef = useRef(onMessage)
  cbRef.current = onMessage

  useEffect(() => {
    const handler = (msg: WsMessage) => cbRef.current?.(msg)
    listeners.add(handler)
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connect(() => setConnected(true))
    } else {
      setConnected(true)
    }
    return () => {
      listeners.delete(handler)
    }
  }, [])

  const send = useCallback((msg: unknown) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg))
  }, [])

  return { connected, send }
}

// Drop-in subscription hook scoped to a signal filter.
export function useServiceEvents(serviceId: string | null, onEvent?: (msg: WsMessage) => void) {
  const ref = useRef(onEvent)
  ref.current = onEvent
  useEffect(() => {
    if (!serviceId) return
    const handler = (msg: WsMessage) => {
      const data = (msg as any).data
      if (data && data.serviceId === serviceId) ref.current?.(msg)
    }
    listeners.add(handler)
    return () => { listeners.delete(handler) }
  }, [serviceId])
  return {
    connect: useCallback(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'subscribe', topic: `svc:${serviceId}` }))
      }
    }, [serviceId]),
  }
}
