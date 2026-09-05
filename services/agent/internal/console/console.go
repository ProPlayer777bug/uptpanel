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
	"strings"
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

// connEntry holds per-connection console state: the cancel function of the
// active log-follow stream (re-anchored on every container start/restart) and
// a write lock so concurrent stream goroutines never trample each other's
// websocket frames.
type connEntry struct {
	base   context.Context
	cancel context.CancelFunc
	wmu    sync.Mutex
}

type Hub struct {
	dm  *docker.Client
	mu  sync.Mutex
	// conns tracks active console connections per container id.
	conns map[string]map[*websocket.Conn]*connEntry
}

func NewHub(dm *docker.Client) *Hub {
	return &Hub{dm: dm, conns: map[string]map[*websocket.Conn]*connEntry{}}
}

// OnPower re-anchors the live log stream for every connected console of the
// given server after the container is (re)started. The panel triggers power
// actions over REST (not the console websocket), so the daemon instead of the
// client is what re-installs the follow — otherwise docker's log stream ends
// when the previous container stops and the reboot output never surfaces.
func (h *Hub) OnPower(serverID string) {
	h.mu.Lock()
	conns := make([]*websocket.Conn, 0, len(h.conns[serverID]))
	for c := range h.conns[serverID] {
		conns = append(conns, c)
	}
	h.mu.Unlock()
	for _, ws := range conns {
		e := h.entry(ws)
		if e == nil {
			continue
		}
		e.wmu.Lock()
		h.startStream(serverID, ws, e)
		e.wmu.Unlock()
	}
}

// entry returns the connEntry for ws, or nil when ws isn't tracked.
func (h *Hub) entry(ws *websocket.Conn) *connEntry {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, conns := range h.conns {
		if e, ok := conns[ws]; ok {
			return e
		}
	}
	return nil
}

func (h *Hub) Serve(serverID string, ws *websocket.Conn) {
	defer ws.Close()

	subKey := serverID
	h.mu.Lock()
	if h.conns[subKey] == nil {
		h.conns[subKey] = map[*websocket.Conn]*connEntry{}
	}
	h.conns[subKey][ws] = &connEntry{}
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

	e := h.entry(ws)
	e.base = baseCtx
	h.startStream(serverID, ws, e)

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
					e := h.entry(ws)
					e.wmu.Lock()
					h.startStream(serverID, ws, e)
					e.wmu.Unlock()
				}
			}(action)
		case sendCommand:
			if len(m.Args) == 0 || m.Args[0] == "" {
				continue
			}
			cmd := m.Args[0]
			go func(c string) {
				if isSparkCommand(c) {
					h.send(ws, Message{Event: consoleOut, Args: []string{"> " + c}})
					h.send(ws, Message{Event: consoleOut, Args: []string{"spark is disabled on this server"}})
					return
				}
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
func (h *Hub) startStream(serverID string, ws *websocket.Conn, e *connEntry) {
	if e.cancel != nil {
		e.cancel()
	}
	parent := context.Background()
	if e.base != nil {
		parent = e.base
	}
	ctx, cancel := context.WithCancel(parent)
	e.cancel = cancel
	go func() {
		err := h.dm.StreamLogs(ctx, serverID, "200", "", func(line []byte) {
			e.wmu.Lock()
			defer e.wmu.Unlock()
			_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
			_ = ws.WriteJSON(Message{Event: consoleOut, Args: []string{string(line)}})
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
	e := h.entry(ws)
	if e != nil {
		e.wmu.Lock()
		defer e.wmu.Unlock()
	}
	_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = ws.WriteJSON(m)
}

// isSparkCommand reports whether a console command is a Spark invocation
// (the spark <subcommand> family: "spark", "spark tps", "spark profiler").
// Spark is compiled into the Paper jar, so its commands are rejected node-side
// for every user instead of the plugin being removed from the jar.
func isSparkCommand(cmd string) bool {
	c := strings.TrimSpace(strings.TrimPrefix(cmd, "/"))
	if c == "" {
		return false
	}
	first := strings.Fields(c)[0]
	return strings.EqualFold(first, "spark")
}
