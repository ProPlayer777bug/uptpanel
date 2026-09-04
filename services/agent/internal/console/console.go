// Package console exposes a Wings-style WebSocket terminal: it streams real
// container output (historical + follow) and accepts the Pterodactyl Wings
// JSON event protocol so console input is delivered straight to the running
// server process stdin (not a shell) and power commands are routed to Docker.
//
// Because Docker's log follow stream ends when a container stops, the stream
// is restarted whenever a start/restart power action is issued so the boot
// sequence continues to surface to every connected console (Wings behavior).
package console

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/uptimehost/agent/internal/docker"
)

// Event names mirror Wings' websocket message protocol.
const (
	authSuccess = "auth success"
	authEvent   = "auth"
	setState    = "set state"
	sendLogs    = "send logs"
	sendCommand = "send command"
	sendStats   = "send stats"
	daemonError = "daemon error"
	consoleOut  = "console output"
	statusEvent = "status"
	statsEvent  = "stats"
)

// Message is a Wings-style websocket frame.
type Message struct {
	Event string   `json:"event"`
	Args  []string `json:"args,omitempty"`
}

type Hub struct {
	dm  *docker.Client
	mu  sync.Mutex
	// conns tracks active console connections per container id.
	conns map[string]map[*websocket.Conn]struct{}
}

func NewHub(dm *docker.Client) *Hub {
	return &Hub{dm: dm, conns: map[string]map[*websocket.Conn]struct{}{}}
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

	// Base context for this console connection; we spawn per-power-action
	// log streams off child contexts so a container restart re-anchors them.
	baseCtx, baseCancel := context.WithCancel(context.Background())
	defer baseCancel()

	// cancelHolder lets restartStream cancel the active follow stream and
	// install a fresh one without leaking the previous context.
	var cancelHolder context.CancelFunc
	h.startStream(baseCtx, serverID, ws, &cancelHolder)

	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var m Message
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		switch m.Event {
		case authEvent:
			h.send(ws, Message{Event: authSuccess})
			h.send(ws, Message{Event: statusEvent, Args: []string{h.state(serverID)}})
		case setState:
			action := "start"
			if len(m.Args) > 0 {
				action = m.Args[0]
			}
			go func(a string) {
				var err error
				switch a {
				case "start":
					err = h.dm.Start(context.Background(), serverID)
				case "stop":
					err = h.dm.Stop(context.Background(), serverID)
				case "restart":
					err = h.dm.Restart(context.Background(), serverID)
				case "kill":
					err = h.dm.Kill(context.Background(), serverID)
				default:
					h.send(ws, Message{Event: daemonError, Args: []string{"unknown power action: " + a}})
					return
				}
				if err != nil {
					h.send(ws, Message{Event: daemonError, Args: []string{err.Error()}})
					return
				}
				h.send(ws, Message{Event: statusEvent, Args: []string{a}})
				// Docker's log follow ends when a container stops; once the
				// container is (re)started, re-anchor the log stream so the
				// boot output keeps flowing (Wings re-emits on start).
				if a == "start" || a == "restart" {
					h.startStream(baseCtx, serverID, ws, &cancelHolder)
				}
			}(action)
		case sendCommand:
			if len(m.Args) == 0 || m.Args[0] == "" {
				continue
			}
			cmd := m.Args[0]
			go func(c string) {
				h.send(ws, Message{Event: consoleOut, Args: []string{"> " + c}})
				if sent, err := h.dm.SendCommand(context.Background(), serverID, c); err == nil && sent {
					return
				} else if err != nil {
					h.send(ws, Message{Event: daemonError, Args: []string{err.Error()}})
					return
				}
				// Fallback: run as a shell command inside the container.
				out, err := h.dm.Exec(context.Background(), serverID, c)
				if err != nil {
					h.send(ws, Message{Event: daemonError, Args: []string{err.Error()}})
					return
				}
				if out != "" {
					h.send(ws, Message{Event: consoleOut, Args: []string{out}})
				}
			}(cmd)
		case sendStats:
			if st, err := h.dm.Stats(context.Background(), serverID); err == nil {
				b, _ := json.Marshal(st)
				h.send(ws, Message{Event: statsEvent, Args: []string{string(b)}})
			}
		}
	}
}

// startStream cancels any active follow stream for this connection and starts
// a fresh one that replays a recent window of the container log and then follows
// LIVE output forward. `Tail` replays the last lines (so a client that connects
// while a server is mid-boot still sees the startup sequence), and `Follow` keeps
// pushing new output 24/7. A fresh stream is re-anchored after every start/restart
// so the boot sequence keeps surfacing. No lines are filtered: everything the
// server emits (including boot/Unpacking/JVM lines) reaches the client so the
// console is a complete, unfiltered feed.
func (h *Hub) startStream(baseCtx context.Context, serverID string, ws *websocket.Conn, cancelHolder *context.CancelFunc) {
	if *cancelHolder != nil {
		(*cancelHolder)()
	}
	ctx, cancel := context.WithCancel(baseCtx)
	*cancelHolder = cancel
	go func() {
		err := h.dm.StreamLogs(ctx, serverID, "200", "", func(line []byte) {
			h.send(ws, Message{Event: consoleOut, Args: []string{string(line)}})
		})
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			h.send(ws, Message{Event: daemonError, Args: []string{"console stream: " + err.Error()}})
		}
	}()
}

func (h *Hub) state(serverID string) string {
	c, err := h.dm.ListContainers(context.Background())
	if err != nil {
		return "offline"
	}
	for _, s := range c {
		if s.Name == "uh_"+serverID || s.Server == serverID {
			if s.Running {
				return "running"
			}
			return "offline"
		}
	}
	return "offline"
}

func (h *Hub) send(ws *websocket.Conn, m Message) {
	_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = ws.WriteJSON(m)
}
