import { useEffect, useState, useCallback } from 'react'

export type WSMessage =
  | { event: 'auth_success' }
  | { event: 'auth_error'; reason: string }
  | { event: 'console_output'; line: string }
  | { event: 'server_status'; status: 'OFFLINE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'RESTARTING' | 'CRASHED' }
  | { event: 'error'; message: string }

export type WSProtocolMessage =
  | { event: 'auth'; args: [string] }
  | { event: 'subscribe'; args: [string] }
  | { event: 'send_command'; args: [string] }
  | { event: 'ping'; args: [null] }
  | { event: 'pong'; args: [null] }

export interface UseWebSocketOptions {
  token: string
  serverId: string
  autoReconnect?: boolean
  reconnectInterval?: number
}

export function useWebSocket({
  token,
  serverId,
  autoReconnect = true,
  reconnectInterval = 1000,
}: UseWebSocketOptions) {
  const [ws, setWs] = useState<WebSocket | null>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting'>(
    'connecting'
  )
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null)
  const [reconnectAttempts, setReconnectAttempts] = useState(0)
  const [maxAttempts, setMaxAttempts] = useState(10)

  const connect = useCallback(() => {
    const socket = new WebSocket(`wss://panel.uptimehost.in:3000/console?server=${serverId}&token=${token}`)
    setWs(socket)
    setState('connecting')

    socket.onopen = () => {
      setState('open')
      setReconnectAttempts(0)
      // Authenticate immediately
      socket.send(JSON.stringify({ event: 'auth', args: [token] }))
      socket.send(JSON.stringify({ event: 'subscribe', args: [serverId] }))
    }

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data) as WSProtocolMessage
      handleIncomingMessage(socket, data)
    }

    socket.onclose = (event) => {
      setState('closed')
      if (autoReconnect && reconnectAttempts < maxAttempts) {
        setState('reconnecting')
        setReconnectAttempts((prev) => prev + 1)
        const delay = Math.min(reconnectInterval * 2 ** reconnectAttempts, 30000)
        setTimeout(connect, delay)
      }
    }

    socket.onerror = (error) => {
      setLastMessage({ event: 'error', message: `WebSocket error: ${error.message}` })
      setState('closed')
    }
  }, [autoReconnect, reconnectInterval, serverId, token])

  const handleIncomingMessage = (socket: WebSocket, data: WSProtocolMessage) => {
    switch (data.event) {
      case 'auth_success':
        setState('open')
        break
      case 'auth_error':
        setLastMessage({ event: 'auth_error', reason: data.reason })
        setState('closed')
        socket.close()
        break
      case 'console_output':
        setLastMessage({ event: 'console_output', line: data.args[0] })
        // Re-emit via callback if provided
        break
      case 'server_status':
        setLastMessage({
          event: 'server_status',
          status: data.args[0] as WSMessage['status'],
        })
        break
      case 'ping':
        socket.send(JSON.stringify({ event: 'pong', args: [null] }))
        break
      default:
        setLastMessage({ event: 'error', message: `Unknown event: ${data.event}` })
    }
  }

  const sendCommand = useCallback(
    (command: string) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ event: 'send_command', args: [command] }))
    },
    [ws]
  )

  const disconnect = useCallback(() => {
    if (ws) {
      ws.close()
      setState('closed')
    }
  }, [ws])

  return {
    ws,
    state,
    lastMessage,
    reconnectAttempts,
    maxAttempts,
    connect,
    disconnect,
    sendCommand,
  }
}