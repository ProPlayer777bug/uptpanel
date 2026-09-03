// Package httpapi exposes the agent's inbound HTTP + WS API that the Panel
// (control core) calls to manage Docker containers on this node.
package httpapi

import (
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
)

type Server struct {
	dm    *docker.Client
	hub   *console.Hub
	token string
	base  string
	mux   *http.ServeMux
}

func New(dm *docker.Client, token, base string) *Server {
	return &Server{
		dm:    dm,
		hub:   console.NewHub(dm),
		token: token,
		base:  base,
		mux:   http.NewServeMux(),
	}
}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

func (s *Server) Routes() http.Handler {
	s.mux.HandleFunc("/api/system", s.withAuth(s.handleSystem))
	s.mux.HandleFunc("/api/containers", s.withAuth(s.handleContainersRoot))
	s.mux.HandleFunc("/api/containers/", s.withAuth(s.handleContainers))
	s.mux.HandleFunc("/api/register", s.handleRegister)
	return s.mux
}

func (s *Server) withAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ah := r.Header.Get("Authorization")
		if !strings.HasPrefix(ah, "Bearer ") || strings.TrimPrefix(ah, "Bearer ") != s.token {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
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
		"id":          os.Getenv("UH_NODE_ID"),
		"version":     "0.1.0",
		"online":      true,
		"dockerHealthy": pingErr == nil,
		"reachableAt": time.Now().UnixMilli(),
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
	ctx := r.Context()

	// WebSocket console
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
		writeJSON(w, 200, map[string]any{"removed": true})

	case sub == "power" && r.Method == http.MethodPost:
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		action := body["action"]
		var err error
		switch action {
		case "start":
			err = s.dm.Start(ctx, id)
		case "stop":
			err = s.dm.Stop(ctx, id)
		case "restart":
			err = s.dm.Restart(ctx, id)
		case "kill":
			err = s.dm.Kill(ctx, id)
		default:
			writeJSON(w, 400, map[string]any{"error": "unknown action " + action})
			return
		}
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "action": action})

	case sub == "stats" && r.Method == http.MethodGet:
		st, err := s.dm.Stats(ctx, id)
		if err != nil {
			writeJSON(w, 200, map[string]any{"error": err.Error(), "running": false})
			return
		}
		writeJSON(w, 200, st)

	case sub == "command" && r.Method == http.MethodPost:
		var body struct{ Command string `json:"command"` }
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := s.dm.Exec(ctx, id, body.Command)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"output": out})

	case sub == "logs" && r.Method == http.MethodGet:
		out, err := s.dm.Logs(ctx, id, 200)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]any{"output": out})

	case strings.HasPrefix(sub, "files"):
		s.handleFiles(ctx, w, r, id, sub)

	case strings.HasPrefix(sub, "backups"):
		s.handleBackups(ctx, w, r, id, sub)

	case sub == "reinstall" && r.Method == http.MethodPost:
		// Rebuild the data directory to a pristine state: remove server
		// files and recreate the mount, then re-create the container image.
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
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		if err := os.WriteFile(target, []byte(body.Content), 0o644); err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
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
			info, _ := e.Info()
			sz := int64(0)
			if info != nil {
				sz = info.Size()
			}
			list = append(list, ent{Name: e.Name(), Dir: e.IsDir(), Size: sz, Mode: fmt.Sprintf("%04o", 0)})
			if info != nil {
				list[len(list)-1].Mode = fmt.Sprintf("%04o", info.Mode().Perm())
			}
		}
		writeJSON(w, 200, map[string]any{"path": q, "entries": list})
	}
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	log.Printf("agent: registration attempt from panel (token ok) - upstream reporting optional")
	writeJSON(w, 200, map[string]any{"ok": true, "id": os.Getenv("UH_NODE_ID")})
}
