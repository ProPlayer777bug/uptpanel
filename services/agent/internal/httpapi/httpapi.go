// Package httpapi exposes the agent's inbound HTTP + WS API that the Panel
// (control core) calls to manage Docker containers on this node.
package httpapi

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/uptimehost/agent/internal/backup"
	"github.com/uptimehost/agent/internal/console"
	"github.com/uptimehost/agent/internal/docker"
	"github.com/uptimehost/agent/internal/players"
	"github.com/uptimehost/agent/internal/signing"
)

type Server struct {
	dm       *docker.Client
	hub      *console.Hub
	token    string
	nodeID   string
	base     string
	mux      *http.ServeMux
	verifier *signing.Verifier
}

func New(dm *docker.Client, token, nodeID, base string) *Server {
	// The players package reads server files from the same data base dir.
	players.Base = base
	return &Server{
		dm:       dm,
		hub:      console.NewHub(dm),
		token:    token,
		nodeID:   nodeID,
		base:     base,
		mux:      http.NewServeMux(),
		verifier: signing.NewVerifier(4096),
	}
}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

func (s *Server) Routes() http.Handler {
	// Wings-style daemon API: the Panel calls these by Bearer token to manage
	// the server's container(s) on this node.
	s.mux.HandleFunc("/api/system", s.withAuth(s.handleSystem))
	s.mux.HandleFunc("/api/containers", s.withAuth(s.handleContainersRoot))
	// Legacy container paths are kept as an alias so existing deployments keep
	// working during the transition; the canonical paths are the /api/servers
	// routes below.
	s.mux.HandleFunc("/api/containers/", s.withAuth(s.handleContainers))
	s.mux.HandleFunc("/api/servers", s.withAuth(s.handleContainersRoot))
	s.mux.HandleFunc("/api/servers/", s.withAuth(s.handleServers))
	s.mux.HandleFunc("/api/register", s.handleRegister)
	return s.mux
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-ID")
		if reqID == "" {
			reqID = signing.NewRequestID()
		}
		w.Header().Set("X-Request-ID", reqID)

		if !s.authorize(r) {
			writeErr(w, reqID, http.StatusUnauthorized, "UNAUTHORIZED", "request signature or node secret invalid")
			return
		}
		next(w, r)
	}
}

// authorize accepts a request when it carries a valid HMAC signature over the
// canonical request (preferred, short-lived + replay-protected) OR, as a
// transitional fallback, a matching static bearer token. The bearer path is
// kept so existing deployments and the console upgrade chain keep working.
func (s *Server) authorize(r *http.Request) bool {
	nodeID := r.Header.Get("X-Node-ID")
	sig := r.Header.Get("X-Signature")
	ts := r.Header.Get("X-Timestamp")
	reqID := r.Header.Get("X-Request-ID")

	if nodeID != "" || sig != "" || ts != "" {
		if nodeID != s.nodeID {
			return false
		}
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(strings.NewReader(string(body)))
		res := s.verifier.Verify(nodeID, r.Method, r.URL.RequestURI(), reqID, ts, sig, s.token, body, time.Now())
		return res == signing.ResultOK
	}

	ah := r.Header.Get("Authorization")
	return strings.HasPrefix(ah, "Bearer ") && strings.TrimPrefix(ah, "Bearer ") == s.token
}

// writeErr emits the consistent error envelope used by every agent response.
func writeErr(w http.ResponseWriter, reqID string, code int, errCode, message string) {
	v := map[string]any{
		"success":    false,
		"request_id": reqID,
		"error": map[string]any{
			"code":    errCode,
			"message": message,
		},
	}
	writeJSON(w, code, v)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) handleSystem(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()

	pingErr := s.dm.Ping(ctx)
	resp := map[string]any{
		"id":            os.Getenv("UH_NODE_ID"),
		"version":       "0.1.0",
		"online":        true,
		"dockerHealthy": pingErr == nil,
		"reachableAt":   time.Now().UnixMilli(),
	}
	if stats, err := ReadHostStats(); err == nil {
		resp["host"] = stats
	}
	if pingErr == nil {
		resp["containers"] = 0
		if names, err := s.dm.ListAll(ctx); err == nil {
			resp["containers"] = len(names)
		}
	}
	writeJSON(w, 200, resp)
}

func (s *Server) handleContainersRoot(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
		defer cancel()
		list, err := s.dm.ListContainers(ctx)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"containers": list})
	case http.MethodPost:
		var m docker.Manifest
		if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
			writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
			return
		}
		if m.MountData == "" {
			m.MountData = filepath.Join(s.base, m.ID)
			_ = os.MkdirAll(m.MountData, 0o755)
		}
		// Ensure the container runtime user owns the data directory so the
		// server can write its world/data (Wings-style chown). Defaults to the
		// standard yolks container uid (1001) unless the panel specifies one.
		if m.UID <= 0 {
			m.UID = 1001
		}
		if err := os.Chown(m.MountData, int(m.UID), int(m.UID)); err != nil {
			writeJSON(w, 500, map[string]any{"error": "chown data dir: " + err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
		defer cancel()
		id, err := s.dm.CreateContainer(ctx, m)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 201, map[string]any{"containerId": id})
	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

func (s *Server) handleContainers(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/containers/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	s.handleServer(w, r, id, sub)
}

// handleServers is the canonical Wings-style server API:
//
//	/api/servers/:server                DELETE  -> remove container
//	/api/servers/:server/power          POST    -> {action: start|stop|restart|kill, wait_seconds}
//	/api/servers/:server/commands       POST    -> {commands: [...]}
//	/api/servers/:server/logs           GET     -> ?tail=N
//	/api/servers/:server/stats          GET
//	/api/servers/:server/ws             (upgrade) Wings JSON console protocol
//	/api/servers/:server/reinstall      POST
//	/api/servers/:server/files/...      files API
//	/api/servers/:server/backups/...    backups API
func (s *Server) handleServers(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/servers/")
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	sub := ""
	if len(parts) > 1 {
		sub = parts[1]
	}
	// Normalize Wings names to the shared internal endpoint names.
	switch {
	case sub == "commands":
		sub = "command"
	case strings.HasPrefix(sub, "files/"):
		// keep as-is; handleServer split handles it
	case strings.HasPrefix(sub, "backup/"):
		sub = "backups/" + strings.TrimPrefix(sub, "backup/")
	}
	s.handleServer(w, r, id, sub)
}

// handleServer routes a server-scoped request to the right backend.
// sub's first segment is the endpooint name; the remainder (if any) is passed
// to the file/backup handlers which split their own sub-paths.
func (s *Server) handleServer(w http.ResponseWriter, r *http.Request, id, sub string) {
	ctx := r.Context()

	// WebSocket console (Wings JSON protocol).
	if sub == "ws" {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.hub.Serve(id, ws)
		return
	}

	switch {
	case r.Method == http.MethodDelete && sub == "":
		if err := s.dm.Remove(ctx, id); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		// Best-effort: never leave orphaned DoS filter rules for a dead server.
		_ = docker.SetAntiDdos(docker.AntiDdosConfig{ServerID: id, Enabled: false})
		players.GuardRCONPort(false)
		writeJSON(w, 200, map[string]any{"removed": true})

	case sub == "power" && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		action, _ := body["action"].(string)
		waitSec, _ := body["wait_seconds"].(int)
		if waitSec <= 0 {
			waitSec = 30
		}
		var err error
		switch action {
		case "start":
			// Minecraft servers get RCON (loopback-bound) enabled before boot so
			// the Player Management Center can query and manage players.
			if serr := players.EnsureEnabled(filepath.Join(s.base, id)); serr != nil {
				log.Printf("[players] ensure rcon: %v", serr)
			}
			players.GuardRCONPort(true)
			err = s.dm.Start(ctx, id)
		case "stop":
			err = s.dm.Stop(ctx, id)
		case "restart":
			err = s.dm.Restart(ctx, id)
		case "kill":
			err = s.dm.Kill(ctx, id)
		default:
			writeJSON(w, 422, map[string]any{"error": "power action must be one of stop/start/restart/kill"})
			return
		}
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		// Re-anchor every connected console's log follow after a start/restart
		// so the boot output surfaces even though power came over REST (the
		// panel's normal start path) rather than the console websocket.
		if action == "start" || action == "restart" {
			s.hub.OnPower(id)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": action})

	case sub == "command" && r.Method == http.MethodPost:
		// Accept both Wings plural {"commands":[...]} and legacy single.
		var body struct {
			Command  string   `json:"command"`
			Commands []string `json:"commands"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cmd := body.Command
		if cmd == "" && len(body.Commands) > 0 {
			cmd = body.Commands[0]
		}
		if isSparkCommand(cmd) {
			writeJSON(w, 403, map[string]any{"ok": false, "error": "spark is disabled on this server"})
			return
		}
		sent, serr := s.dm.SendCommand(ctx, id, cmd)
		if sent && serr == nil {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		if serr != nil {
			writeJSON(w, 500, map[string]any{"error": serr.Error()})
			return
		}
		out, err := s.dm.Exec(ctx, id, cmd)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "output": out})

	case sub == "stats" && r.Method == http.MethodGet:
		st, err := s.dm.Stats(ctx, id)
		if err != nil {
			writeJSON(w, 200, map[string]any{"error": err.Error(), "running": false})
			return
		}
		writeJSON(w, 200, st)

	case sub == "logs" && r.Method == http.MethodGet:
		tail := 200
		if q := r.URL.Query().Get("tail"); q != "" {
			fmt.Sscanf(q, "%d", &tail)
		}
		out, err := s.dm.Logs(ctx, id, tail)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"output": out})

	case strings.HasPrefix(sub, "files"):
		s.handleFiles(ctx, w, r, id, sub)

	case strings.HasPrefix(sub, "backups"):
		s.handleBackups(ctx, w, r, id, sub)

	case sub == "firewall/open" && r.Method == http.MethodPost:
		var body struct {
			Port int `json:"port"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := docker.AllowPort(body.Port); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": "allow", "port": body.Port})

	case sub == "firewall/close" && r.Method == http.MethodPost:
		var body struct {
			Port int `json:"port"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if err := docker.DisallowPort(body.Port); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": "delete", "port": body.Port})

	case sub == "antiddos" && r.Method == http.MethodGet:
		enabled, ports := docker.AntiDdosStatus(id)
		writeJSON(w, 200, map[string]any{"ok": true, "enabled": enabled, "ports": ports})

	case sub == "antiddos" && r.Method == http.MethodPost:
		var body struct {
			Enabled bool   `json:"enabled"`
			Ports   []int  `json:"ports"`
			Level   string `json:"level"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
			return
		}
		level := docker.LevelStandard
		if body.Level == string(docker.LevelStrict) {
			level = docker.LevelStrict
		}
		if err := docker.SetAntiDdos(docker.AntiDdosConfig{
			ServerID: id,
			Ports:    body.Ports,
			Enabled:  body.Enabled,
			Level:    level,
		}); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "enabled": body.Enabled, "ports": body.Ports})

	case sub == "mc-config" && r.Method == http.MethodGet:
		vals, err := players.PropertiesSnapshot(filepath.Join(s.base, id))
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "properties": vals, "schema": players.EditableProps})

	case sub == "mc-config" && r.Method == http.MethodPost:
		var body struct {
			Key   string `json:"key"`
			Value string `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
			return
		}
		if err := players.SetProperty(filepath.Join(s.base, id), body.Key, body.Value); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "key": body.Key, "value": body.Value})

	case sub == "players" && r.Method == http.MethodGet:
		snap, err := players.SnapshotFor(id)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, snap)

	case sub == "players/action" && r.Method == http.MethodPost:
		var body struct {
			Player string   `json:"player"`
			Action string   `json:"action"`
			Args   []string `json:"args"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": "bad request: " + err.Error()})
			return
		}
		if body.Player == "" || body.Action == "" {
			writeJSON(w, 400, map[string]any{"error": "player and action are required"})
			return
		}
		res, err := players.Action(id, body.Player, body.Action, body.Args)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, res)

	case sub == "players/rcon" && r.Method == http.MethodPost:
		var body struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Enabled {
			if err := players.EnsureEnabled(filepath.Join(s.base, id)); err != nil {
				writeJSON(w, 500, map[string]any{"error": err.Error()})
				return
			}
			players.GuardRCONPort(true)
			writeOpts := players.RCONStatus{Enabled: true}
			writeJSON(w, 200, map[string]any{"ok": true, "rcon": writeOpts})
			return
		}
		players.GuardRCONPort(false)
		writeJSON(w, 200, map[string]any{"ok": true, "rcon": map[string]any{"enabled": false}})

	case sub == "reinstall" && r.Method == http.MethodPost:
		hostRoot := filepath.Join(s.base, id)
		if err := os.RemoveAll(hostRoot); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		_ = os.MkdirAll(hostRoot, 0o755)
		writeJSON(w, 200, map[string]any{"ok": true, "action": "reinstall"})

	default:
		writeJSON(w, 404, map[string]any{"error": "not found"})
	}
}

// handleServerParts routes a server-scoped request where the exact sub path is
// already known (used by the legacy container routes which don't need
// Wings-name normalization).
// handleBackups manages on-node ZIP archives of a server's data directory.
//   - POST /backups          {name}        -> create archive, returns meta
//   - GET  /backups?name=X                 -> download archive bytes
//   - DELETE /backups?name=X               -> remove archive
//   - POST /backups/restore  {name}        -> extract archive into data dir
func (s *Server) handleBackups(ctx context.Context, w http.ResponseWriter, r *http.Request, id, sub string) {
	backupRoot := filepath.Join(s.base, "backups", id)
	hostRoot := filepath.Join(s.base, id)

	if strings.HasPrefix(sub, "backups/restore") { // restore
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]any{"error": "method not allowed"})
			return
		}
		var body struct{ Name string `json:"name"` }
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		src := backup.SafeResolve(backupRoot, body.Name)
		if src == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe backup name"})
			return
		}
		if _, err := os.Stat(src); err != nil {
			writeJSON(w, 404, map[string]any{"error": "backup not found"})
			return
		}
		if err := os.MkdirAll(hostRoot, 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		total, err := backup.Extract(src, hostRoot)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "bytes": total})
		return
	}

	switch r.Method {
	case http.MethodPost: // create
		var body struct {
			Name string `json:"name"`
			UUID string `json:"uuid"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		name := body.Name
		if name == "" {
			name = body.UUID
		}
		if name == "" {
			name = fmt.Sprintf("backup-%d.zip", time.Now().Unix())
		}
		dest := backup.SafeResolve(backupRoot, name)
		if dest == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe backup name"})
			return
		}
		_ = os.MkdirAll(filepath.Dir(dest), 0o755)
		total, err := backup.Create(hostRoot, dest)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "name": name, "bytes": total})

	case http.MethodGet: // download
		name := r.URL.Query().Get("name")
		src := backup.SafeResolve(backupRoot, name)
		if src == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe backup name"})
			return
		}
		f, err := os.Open(src)
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": "backup not found"})
			return
		}
		defer f.Close()
		w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(src)+"\"")
		w.Header().Set("Content-Type", "application/zip")
		_, _ = io.Copy(w, f)

	case http.MethodDelete: // delete
		name := r.URL.Query().Get("name")
		src := backup.SafeResolve(backupRoot, name)
		if src == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe backup name"})
			return
		}
		if err := os.Remove(src); err != nil {
			writeJSON(w, 404, map[string]any{"error": "backup not found"})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "removed": name})

	default:
		writeJSON(w, 405, map[string]any{"error": "method not allowed"})
	}
}

// resolvePath maps an in-container path (optionally prefixed with
// /home/container) to a safe host path rooted at hostRoot, refusing any
// traversal outside it. It returns "" when unsafe.
func resolvePath(hostRoot, inContainerPath string) string {
	inner := strings.TrimPrefix(inContainerPath, "/home/container")
	if inner == "" {
		inner = "/"
	}
	return backup.SafeResolve(hostRoot, inner)
}

// isSparkName reports whether a file or directory name is a Spark artifact
// (the Spark profiler/plugin bundled into Paper and its extracted runtime
// directories). Spark is compiled into the Paper jar itself, so it cannot be
// stripped from the jar without breaking the server; instead it is hidden from
// the file manager and its console commands are rejected. Enforcement lives
// node-side so every user is covered regardless of how the plugin arrived
// (uploaded externally, installed from the version/plugin downloader, or
// extracted by the server).
func isSparkName(name string) bool {
	lower := strings.ToLower(name)
	return lower == "spark" ||
		strings.HasPrefix(lower, "spark-") ||
		lower == "lucko"
}

// sparkPathHidden reports whether any path segment of p matches a Spark
// artifact name, meaning the path must be withheld from file-manager callers.
func sparkPathHidden(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == "" {
			continue
		}
		if isSparkName(seg) {
			return true
		}
	}
	return false
}

// isSparkCommand reports whether a console command is a Spark invocation
// (the spark <subcommand> family, e.g. "spark", "spark tps", "spark profiler").
func isSparkCommand(cmd string) bool {
	c := strings.TrimSpace(strings.TrimPrefix(cmd, "/"))
	if c == "" {
		return false
	}
	first := strings.Fields(c)[0]
	return strings.EqualFold(first, "spark")
}

// zipSingleFile zips one regular file into dest, returning bytes written.
func zipSingleFile(src, dest string) (int64, error) {
	info, err := os.Stat(src)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, err
	}
	f, err := os.Create(dest)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	hdr := &zip.FileHeader{Name: filepath.Base(src), Method: zip.Deflate}
	hdr.SetMode(info.Mode().Perm())
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		zw.Close()
		return 0, err
	}
	rc, err := os.Open(src)
	if err != nil {
		zw.Close()
		return 0, err
	}
	n, err := io.Copy(w, rc)
	rc.Close()
	zw.Close()
	return n, err
}

func (s *Server) handleFiles(ctx context.Context, w http.ResponseWriter, r *http.Request, id, sub string) {
	// Resolve container host path: /home/container<path> -> base dir.
	hostRoot := filepath.Join(s.base, id)
	q := r.URL.Query().Get("path")
	if q == "" {
		q = "/"
	}
	fsPath := resolvePath(hostRoot, q)
	if fsPath == "" {
		writeJSON(w, 400, map[string]any{"error": "unsafe path"})
		return
	}
	if sparkPathHidden(q) {
		writeJSON(w, 404, map[string]any{"error": "path not found"})
		return
	}

	switch {
	case strings.HasPrefix(sub, "files/content") && r.Method == http.MethodGet:
		data, err := os.ReadFile(fsPath)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"path": q, "content": string(data)})

	case strings.HasPrefix(sub, "files/write") && r.Method == http.MethodPost:
		var body struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		target := resolvePath(hostRoot, body.Path)
		if target == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if sparkPathHidden(target) {
			writeJSON(w, 404, map[string]any{"error": "path not found"})
			return
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		if err := os.WriteFile(target, []byte(body.Content), 0o644); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path})

	case strings.HasPrefix(sub, "files/download") && r.Method == http.MethodGet:
		// Serve a file's bytes back to the panel for browser download.
		info, err := os.Stat(fsPath)
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": "download: " + err.Error()})
			return
		}
		if info.IsDir() {
			writeJSON(w, 400, map[string]any{"error": "cannot download a directory"})
			return
		}
		f, err := os.Open(fsPath)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		defer f.Close()
		w.Header().Set("Content-Disposition", "attachment; filename=\""+filepath.Base(fsPath)+"\"")
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
		_, _ = io.Copy(w, f)

	case strings.HasPrefix(sub, "files/delete") && r.Method == http.MethodPost:
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.Path == "" {
			writeJSON(w, 400, map[string]any{"error": "path required"})
			return
		}
		target := resolvePath(hostRoot, body.Path)
		if target == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if sparkPathHidden(target) {
			writeJSON(w, 404, map[string]any{"error": "path not found"})
			return
		}
		if target == hostRoot {
			writeJSON(w, 400, map[string]any{"error": "cannot delete server root"})
			return
		}
		info, err := os.Lstat(target)
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": "delete: " + err.Error()})
			return
		}
		if info.IsDir() {
			if err := os.RemoveAll(target); err != nil {
				writeJSON(w, 500, map[string]any{"error": err.Error()})
				return
			}
		} else if err := os.Remove(target); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path})

	case strings.HasPrefix(sub, "files/archive/extract") && r.Method == http.MethodPost:
		// Extract a zip file already present on the node into the current dir.
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.Path == "" {
			writeJSON(w, 400, map[string]any{"error": "path required"})
			return
		}
		src := resolvePath(hostRoot, body.Path)
		if src == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if sparkPathHidden(src) {
			writeJSON(w, 404, map[string]any{"error": "path not found"})
			return
		}
		total, err := backup.Extract(src, hostRoot)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "bytes": total, "path": body.Path})

	case strings.HasPrefix(sub, "files/archive") && r.Method == http.MethodPost:
		// Zip a file or directory on the node into a sibling .zip (like backups
		// but for an arbitrary path). Returns the resulting archive name/size.
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.Path == "" {
			writeJSON(w, 400, map[string]any{"error": "path required"})
			return
		}
		src := resolvePath(hostRoot, body.Path)
		if src == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		info, err := os.Stat(src)
		if err != nil {
			writeJSON(w, 404, map[string]any{"error": "archive: " + err.Error()})
			return
		}
		zipName := filepath.Base(src) + ".zip"
		dest := filepath.Join(filepath.Dir(src), zipName)
		var total int64
		if info.IsDir() {
			total, err = backup.Create(src, dest)
		} else {
			total, err = zipSingleFile(src, dest)
		}
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "file": zipName, "bytes": total, "path": body.Path})

	case strings.HasPrefix(sub, "files/upload") && r.Method == http.MethodPost:
		// Multipart upload of one or more files into the current directory (q).
		if err := r.ParseMultipartForm(1 << 30); err != nil {
			writeJSON(w, 400, map[string]any{"error": "upload: " + err.Error()})
			return
		}
		type saved struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
		}
		savedFiles := make([]saved, 0)
		for fname, fhs := range r.MultipartForm.File {
			for _, fh := range fhs {
				if err := os.MkdirAll(fsPath, 0o755); err != nil {
					writeJSON(w, 500, map[string]any{"error": err.Error()})
					return
				}
target := backup.SafeResolve(fsPath, fname)
		if target == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe upload name: " + fname})
			return
		}
		if sparkPathHidden(target) {
			writeJSON(w, 400, map[string]any{"error": "cannot upload spark artifact"})
			return
		}
		in, err := fh.Open()
				if err != nil {
					writeJSON(w, 500, map[string]any{"error": err.Error()})
					return
				}
				out, err := os.Create(target)
				if err != nil {
					in.Close()
					writeJSON(w, 500, map[string]any{"error": err.Error()})
					return
				}
				n, err := io.Copy(out, in)
				out.Close()
				in.Close()
				if err != nil {
					writeJSON(w, 500, map[string]any{"error": err.Error()})
					return
				}
				savedFiles = append(savedFiles, saved{Name: fname, Size: n})
			}
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": q, "files": savedFiles})

	case strings.HasPrefix(sub, "files/rename") && r.Method == http.MethodPost:
		var body struct {
			From string `json:"from"`
			To   string `json:"to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.From == "" || body.To == "" {
			writeJSON(w, 400, map[string]any{"error": "from and to required"})
			return
		}
		src := resolvePath(hostRoot, body.From)
		dst := resolvePath(hostRoot, body.To)
		if src == "" || dst == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if err := os.Rename(src, dst); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": body.To})

	case strings.HasPrefix(sub, "files/mkdir") && r.Method == http.MethodPost:
		var body struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.Path == "" {
			writeJSON(w, 400, map[string]any{"error": "path required"})
			return
		}
		target := resolvePath(hostRoot, body.Path)
		if target == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if err := os.MkdirAll(target, 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path})

	case strings.HasPrefix(sub, "files/download") && r.Method == http.MethodPost:
		// Stream an external (binary) file into the server's data dir — used to
		// install the Paper server.jar. Pterodactyl-style, provisioning downloads
		// the jar on the node (which has internet) rather than through the panel.
		var body struct {
			Path string `json:"path"`
			URL  string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		if body.URL == "" || body.Path == "" {
			writeJSON(w, 400, map[string]any{"error": "url and path required"})
			return
		}
		target := resolvePath(hostRoot, body.Path)
		if target == "" {
			writeJSON(w, 400, map[string]any{"error": "unsafe path"})
			return
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		req, _ := http.NewRequest(http.MethodGet, body.URL, nil)
		req.Header.Set("User-Agent", "uptimehost-agent/1.0")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			writeJSON(w, 502, map[string]any{"error": "download: " + err.Error()})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			writeJSON(w, 502, map[string]any{"error": "download failed: " + resp.Status})
			return
		}
		f, err := os.Create(target)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		if _, err := io.Copy(f, resp.Body); err != nil {
			f.Close()
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		f.Close()
		writeJSON(w, 200, map[string]any{"ok": true, "path": body.Path})

	default: // files list
		entries, err := os.ReadDir(fsPath)
		if err != nil {
			writeJSON(w, 200, map[string]any{"error": err.Error(), "path": q, "entries": []any{}})
			return
		}
		type ent struct {
			Name  string `json:"name"`
			Dir   bool   `json:"dir"`
			Size  int64  `json:"size"`
			Mode  string `json:"mode"`
		}
		list := make([]ent, 0)
		for _, e := range entries {
			if isSparkName(e.Name()) {
				continue
			}
			info, _ := e.Info()
			sz := int64(0)
			if info != nil {
				sz = info.Size()
			}
			mode := fmt.Sprintf("%04o", 0)
			if info != nil {
				mode = fmt.Sprintf("%04o", info.Mode().Perm())
			}
			list = append(list, ent{Name: e.Name(), Dir: e.IsDir(), Size: sz, Mode: mode})
		}
		writeJSON(w, 200, map[string]any{"path": q, "entries": list})
	}
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	log.Printf("agent: registration attempt from panel (token ok) - upstream reporting optional")
	writeJSON(w, 200, map[string]any{"ok": true, "id": os.Getenv("UH_NODE_ID")})
}
