// Package console exposes a WebSocket terminal: it streams real container
// output (historical + follow) and accepts input lines that are executed
// inside the container, mirroring a game-server console.
package console

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/uptimehost/agent/internal/docker"
)

type Hub struct {
	dm  *docker.Client
	mu  sync.Mutex
	// conns tracks active console connections per container id.
	conns map[string]map[*websocket.Conn]struct{}
}

func NewHub(dm *docker.Client) *Hub {
	return &Hub{dm: dm, conns: map[string]map[*websocket.Conn]struct{}{}}
}

type wireMsg struct {
	Type string `json:"type"` // "log" | "input" | "status"
	Line string `json:"line,omitempty"`
}

func (h *Hub) Serve(serverID string, ws *websocket.Conn) {
	defer ws.Close()

	subKey := serverID
	h.mu.Lock()
	if h.conns[subKey] == nil {
		h.conns[subKey] = map[*websocket.Conn]struct{}{}
	}
	h.conns[subKey][ws] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.conns[subKey], ws)
		h.mu.Unlock()
	}()

	// Stream container logs (historical last 500 + follow).
	go func() {
		err := h.dm.StreamLogs(context.Background(), serverID, "500", func(line []byte) {
			h.send(ws, wireMsg{Type: "log", Line: string(line)})
		})
		if err != nil {
			h.send(ws, wireMsg{Type: "status", Line: "console: " + err.Error()})
		}
	}()

	// Handle input lines from the client (executed in the container).
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var m wireMsg
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m.Type == "command" && m.Line != "" {
			go func(cmd string) {
				out, err := h.dm.Exec(context.Background(), serverID, cmd)
				h.send(ws, wireMsg{Type: "input", Line: "> " + cmd})
				if err != nil {
					h.send(ws, wireMsg{Type: "log", Line: "error: " + err.Error()})
					return
				}
				if out != "" {
					h.send(ws, wireMsg{Type: "log", Line: out})
				}
			}(m.Line)
		}
	}
}

func (h *Hub) send(ws *websocket.Conn, m wireMsg) {
	_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = ws.WriteJSON(m)
}
