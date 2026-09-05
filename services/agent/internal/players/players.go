// Package players implements the Player Management Center: reading the real
// player state of a Minecraft server straight from its files (whitelist, ops,
// bans, usercache, per-player stats and logs) and driving in-game actions over
// the RCON protocol. RCON is enabled automatically by the panel before a
// server starts (server.properties patch), so every running Minecraft server
// on a node is queryable without plugins.
package players

import (
	"bufio"
	"compress/gzip"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"os/exec"
)

const (
	// rconPort is fixed per server (host networking binds it on the node; the
	// loopback bind in server.properties keeps it off the public interface).
	rconPort = 25575
	// joinRe matches a vanilla/paper "joined the game" console line.
	joinRe = `(?i)^\[[^\]]*\] ([-_A-Za-z0-9]{1,16}) (?:joined the game|has joined the game)$`
	// leaveRe matches a vanilla/paper "left the game" console line.
	leaveRe = `(?i)^\[[^\]]*\] ([-_A-Za-z0-9]{1,16}) (?:left the game|has left the game)$`
)

// ListEntry is a player inside one of a server's JSON lists.
type ListEntry struct {
	Name    string `json:"name"`
	UUID    string `json:"uuid"`
	Reason  string `json:"reason,omitempty"`
	Source  string `json:"source,omitempty"`
	Level   int    `json:"level,omitempty"`
	Created string `json:"created,omitempty"`
	Expires string `json:"expires,omitempty"`
	By      string `json:"by,omitempty"`
}

// Meta is the playtime / join tracking for one player.
type Meta struct {
	PlaytimeTicks int   `json:"playtimeTicks,omitempty"`
	FirstJoined   int64 `json:"firstJoined,omitempty"` // epoch ms, null when unknown
	LastJoined    int64 `json:"lastJoined,omitempty"`
	LastSeenAt    int64 `json:"lastSeenAt,omitempty"`
}

// RCONStatus describes whether the server is queryable over RCON.
type RCONStatus struct {
	Enabled bool   `json:"enabled"`
	Reason  string `json:"reason,omitempty"`
}

// Snapshot is the full player-management view for one server.
type Snapshot struct {
	Rcon      RCONStatus                    `json:"rcon"`
	Online    []string                      `json:"online"`
	Whitelist []ListEntry                   `json:"whitelist"`
	Ops       []ListEntry                   `json:"ops"`
	Banned    []ListEntry                   `json:"banned"`
	Known     []ListEntry                   `json:"known"` // union of all UUIDs seen
	Playtime  map[string]int                `json:"playtime"` // uuid -> total ticks
	FirstJoin map[string]int64              `json:"firstJoin"` // uuid -> epoch ms
	LastJoin  map[string]int64              `json:"lastJoin"` // uuid -> epoch ms
	OnlineAt  map[string]int64              `json:"onlineAt"` // uuid -> epoch ms of last online sighting
	Players   map[string]map[string]string  `json:"players"` // uuid -> name/uuid map for front-end lookups
}

// Item is one slot decoded from a /data inventory query.
type Item struct {
	Slot   int    `json:"slot"`
	ID     string `json:"id"`
	Count  int    `json:"count"`
	Tag    string `json:"tag,omitempty"`
}

// Action performs an RCON-backed management action. Inventory/EnderChest are
// read-only queries whose raw response is returned alongside the parsed items.
func Action(sid, player, action string, args []string) (*ActionResult, error) {
	res := &ActionResult{}
	cfg := readServerProperties(dataDir(sid))
	if !cfg.Enabled {
		res.NeedsRCON = "RCON is not enabled — restart the server to activate it"
		return res, nil
	}

	// Unknown actions are passed through as raw server commands.
	cmd := action
	if fn, ok := actions[action]; ok {
		cmd = fn(player, args)
	}

	conn, err := dial(cfg.Password)
	if err != nil {
		res.Error = "server offline or RCON unreachable"
		return res, nil
	}
	defer conn.Close()
	output, err := conn.Command(cmd)
	if err != nil {
		res.Error = err.Error()
		return res, err
	}
	res.Ran = true
	res.Output = strings.TrimSpace(output)
	if action == "inventory" || action == "enderchest" {
		res.Items = parseItems(res.Output)
	}
	return res, nil
}

// IsOnline reports whether a player is among the currently connected set.
func IsOnline(sid, player string) (bool, error) {
	cfg := readServerProperties(dataDir(sid))
	if !cfg.Enabled {
		return false, nil
	}
	conn, err := dial(cfg.Password)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	resp, err := conn.Command("list")
	if err != nil {
		return false, err
	}
	for _, n := range parseOnline(resp) {
		if strings.EqualFold(n, player) {
			return true, nil
		}
	}
	return false, nil
}

type ActionResult struct {
	Ran       bool   `json:"ran"` // false when the server was offline/RCON unavailable
	Output    string `json:"output"`
	Items     []Item `json:"items"` // filled for inventory/ender queries
	NeedsRCON string `json:"needsRCON,omitempty"`
	Error     string `json:"error,omitempty"`
}

// filesystemSnapshot provides the parts of Snapshot that are derived purely
// from server files (never RCON), so a stopped server still yields them.

// ---------------------------------------------------------------------------
// Filesystem snapshot
// ---------------------------------------------------------------------------

type jsonFile struct{ path, rel string }

// Base is the node data directory holding one folder per server (mounted into
// each container at /home/container). Set by the httpapi package at startup.
var Base = "/var/lib/uptimehost/data"

// dataDir returns the host directory holding the server's files.
func dataDir(sid string) string {
	return filepath.Join(Base, sid)
}

func readList(path string) ([]ListEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []ListEntry
	if err := json.Unmarshal(data, &out); err != nil {
		// A malformed file is not fatal — return empty.
		return nil, nil
	}
	return out, nil
}

// uuidFromName resolves a username to its current UUID via usercache.json.
func uuidFromName(dir, name string) string {
	usercache := filepath.Join(dir, "usercache.json")
	data, _ := os.ReadFile(usercache)
	var entries []struct {
		Name string `json:"name"`
		UUID string `json:"uuid"`
	}
	_ = json.Unmarshal(data, &entries)
	for _, e := range entries {
		if strings.EqualFold(e.Name, name) {
			return e.UUID
		}
	}
	return ""
}

// statsPlaytime sums the play_one_minute custom stat across every stats
// directory (overworld, nether, end) for a UUID.
func statsPlaytime(dir, uuid string) int {
	total := 0
	for _, sd := range []string{"stats"} {
		base := filepath.Join(dir, "world", sd)
		if _, err := os.Stat(base); err != nil {
			continue
		}
		f := filepath.Join(base, uuid+".json")
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var stat struct {
			Stats struct {
				Custom map[string]int `json:"minecraft:custom"`
			} `json:"stats"`
		}
		_ = json.Unmarshal(data, &stat)
		total += stat.Stats.Custom["minecraft:play_one_minute"]
	}
	return total
}

// logTimestamps parses the server logs (including rotated .gz files) for the
// first/last join timestamps of every player.
func logTimestamps(dir string) (first, last map[string]int64) {
	first = map[string]int64{}
	last = map[string]int64{}
	logDir := filepath.Join(dir, "logs")
	entries, err := os.ReadDir(logDir)
	if err != nil {
		return first, last
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasSuffix(name, ".log") || strings.HasSuffix(name, ".log.gz") {
			files = append(files, filepath.Join(logDir, name))
		}
	}
	// Rotated files are named YYYY-MM-DD-N.log(.gz): sort so oldest first.
	sort.Slice(files, func(i, j int) bool {
		return extractLogTS(files[i]) < extractLogTS(files[j])
	})
	jre := regexp.MustCompile(joinRe)
	lre := regexp.MustCompile(leaveRe)
	for _, f := range files {
		lines, tss := scanLog(f)
		for i, line := range lines {
			var ts int64
			if i < len(tss) {
				ts = tss[i]
			}
			if m := jre.FindStringSubmatch(line); m != nil {
				name := m[1]
				if _, ok := first[name]; !ok {
					first[name] = ts
				}
				last[name] = ts
			} else if lre.MatchString(line) {
				if m := lre.FindStringSubmatch(line); m != nil {
					if _, ok := first[m[1]]; !ok {
						first[m[1]] = ts
					}
				}
			}
		}
	}
	return first, last
}

func extractLogTS(f string) int64 {
	base := filepath.Base(f)
	base = strings.TrimSuffix(base, ".gz")
	m := regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})-\d+\.log$`).FindStringSubmatch(base)
	if m == nil {
		return time.Now().Unix()
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	t, err := time.ParseInLocation("2006-01-02", fmt.Sprintf("%04d-%02d-%02d", y, mo, d), time.Local)
	if err != nil {
		return 0
	}
	return t.Unix() * 1000
}

// scanLog iterates over a potentially-gzipped log file's lines, returning
// parsed line->[timestamp ms] pairs.
func scanLog(f string) (out []string, ts []int64) {
	r := openMaybeGzip(f)
	if r == nil {
		return out, ts
	}
	defer r.Close()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		// Console lines carry a timestamp like "11:24:33 [Server thread/INFO]".
		m := regexp.MustCompile(`^(\d{2}):(\d{2}):(\d{2})\s`).FindStringSubmatch(line)
		if m == nil {
			continue
		}
		h, _ := strconv.Atoi(m[1])
		mi, _ := strconv.Atoi(m[2])
		se, _ := strconv.Atoi(m[3])
		now := time.Now()
		ts = append(ts, time.Date(now.Year(), now.Month(), now.Day(), h, mi, se, 0, time.Local).Unix()*1000)
		out = append(out, line)
	}
	return out, ts
}

func openMaybeGzip(f string) io.ReadCloser {
	fh, err := os.Open(f)
	if err != nil {
		return nil
	}
	if strings.HasSuffix(f, ".gz") {
		gz, err := gzip.NewReader(fh)
		if err != nil {
			fh.Close()
			return nil
		}
		return &gzipCloser{gz: gz, fh: fh}
	}
	return fh
}

type gzipCloser struct {
	gz *gzip.Reader
	fh *os.File
}

func (g *gzipCloser) Read(p []byte) (int, error) { return g.gz.Read(p) }
func (g *gzipCloser) Close() error {
	g.gz.Close()
	return g.fh.Close()
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

// SnapshotFor builds the full player view for a server directly from its files
// plus, when the server is running, an RCON "list" for the online set.
func SnapshotFor(sid string) (*Snapshot, error) {
	s := &Snapshot{
		Playtime: map[string]int{},
		FirstJoin: map[string]int64{},
		LastJoin:  map[string]int64{},
		OnlineAt:  map[string]int64{},
		Players:   map[string]map[string]string{},
	}
	dir := dataDir(sid)
	if _, err := os.Stat(dir); err != nil {
		return nil, fmt.Errorf("server data directory missing: %w", err)
	}

	s.Whitelist, _ = readList(filepath.Join(dir, "whitelist.json"))
	s.Ops, _ = readList(filepath.Join(dir, "ops.json"))
	s.Banned, _ = readList(filepath.Join(dir, "banned-players.json"))

	usercache, _ := readList(filepath.Join(dir, "usercache.json"))

	// Playtime + joins from stats/logs (works regardless of server state).
	stats, err := os.ReadDir(filepath.Join(dir, "world", "stats"))
	if err == nil {
		for _, e := range stats {
			if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
				continue
			}
			uuid := strings.TrimSuffix(e.Name(), ".json")
			if p := statsPlaytime(dir, uuid); p > 0 {
				s.Playtime[uuid] = p
			}
		}
	}
	first, last := logTimestamps(dir)
	s.FirstJoin = first
	s.LastJoin = last

	byUUID := map[string]string{}
	for _, e := range append(append(append([]ListEntry{}, usercache...), s.Whitelist...), append(s.Ops, s.Banned...)...) {
		if e.UUID == "" || e.Name == "" {
			continue
		}
		if _, ok := byUUID[e.UUID]; !ok {
			byUUID[e.UUID] = e.Name
		}
	}
	for uuid, name := range byUUID {
		s.Known = append(s.Known, ListEntry{Name: name, UUID: uuid})
		s.Players[uuid] = map[string]string{"name": name, "uuid": uuid}
	}
	sort.Slice(s.Known, func(i, j int) bool { return strings.ToLower(s.Known[i].Name) < strings.ToLower(s.Known[j].Name) })

	// Online set through RCON when available.
	cfg := readServerProperties(dir)
	if cfg.Enabled {
		conn, err := dial(cfg.Password)
		if err != nil {
			s.Rcon = RCONStatus{Enabled: false, Reason: "server offline or RCON not reachable"}
		} else {
			s.Rcon = RCONStatus{Enabled: true}
			resp, _ := conn.Command("list")
			conn.Close()
			s.Online = parseOnline(resp)
			now := time.Now().UTC().Unix() * 1000
			for _, name := range s.Online {
				s.OnlineAt[name] = now
			}
		}
	} else {
		s.Rcon = RCONStatus{Enabled: false, Reason: "RCON not enabled — restart the server"}
	}
	return s, nil
}

// parseOnline extracts the player names from a "list" response like
// "There are 2 of a max of 20 players online: Alice, Bob".
func parseOnline(resp string) []string {
	idx := strings.LastIndex(resp, ":")
	if idx < 0 {
		return []string{}
	}
	names := strings.Split(strings.TrimSpace(resp[idx+1:]), ",")
	out := make([]string, 0, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n != "" {
			out = append(out, n)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// RCON protocol
// ---------------------------------------------------------------------------

// wrapper is a minimal Source RCON client (full-text response, no auth
// parsing) speaking the vanilla Minecraft variant over localhost.
type wrapper struct{ conn net.Conn }

func (w *wrapper) Close() { _ = w.conn.Close() }

func (w *wrapper) Command(cmd string) (string, error) {
	// Minecraft RCON (mcrcon layout): little-endian ints, length field counts
	// request id + type + payload + two trailing NULs. Vanilla's listener
	// expects the length prefix to equal the total transmitted bytes minus 4.
	payload := []byte(cmd)
	packet := make([]byte, 0, 14+len(payload))
	packet = binary.LittleEndian.AppendUint32(packet, uint32(10+len(payload)))
	packet = binary.LittleEndian.AppendUint32(packet, 1) // request id
	packet = binary.LittleEndian.AppendUint32(packet, 2) // command type
	packet = append(packet, payload...)
	packet = append(packet, 0, 0) // two null terminators
	if _, err := w.conn.Write(packet); err != nil {
		return "", err
	}
	var resp strings.Builder
	for {
		l, body, err := readPacket(w.conn)
		if err != nil {
			return "", err
		}
		payloadBytes := body[8 : l-2]
		resp.Write(payloadBytes)
		// sendCmdResponse splits long output into <=4096-byte chunks; a chunk
		// smaller than the maximum marks the final response.
		if l < 4096+14 {
			break
		}
	}
	return resp.String(), nil
}

func readPacket(r io.Reader) (uint32, []byte, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, nil, err
	}
	length := binary.LittleEndian.Uint32(head)
	if length < 10 || length > 16384 {
		return 0, nil, fmt.Errorf("bad rcon response length %d", length)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(r, body); err != nil {
		return 0, nil, err
	}
	if len(body) < 10 {
		return 0, nil, errors.New("short rcon response")
	}
	return length, body, nil
}

// dial connects and authenticates over loopback.
func dial(password string) (*wrapper, error) {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", rconPort), 2*time.Second)
	if err != nil {
		return nil, err
	}
	w := &wrapper{conn: conn}
	auth := make([]byte, 0, 14+len(password))
	auth = binary.LittleEndian.AppendUint32(auth, uint32(10+len(password)))
	auth = binary.LittleEndian.AppendUint32(auth, 2) // request id
	auth = binary.LittleEndian.AppendUint32(auth, 3) // login type
	auth = append(auth, password...)
	auth = append(auth, 0, 0)
	if _, err := conn.Write(auth); err != nil {
		conn.Close()
		return nil, err
	}
	length, body, err := readPacket(conn)
	if err != nil {
		conn.Close()
		return nil, err
	}
	// Login success is type 2 (SERVERDATA_AUTH_RESPONSE), failure is -1.
	respType := int32(binary.LittleEndian.Uint32(body[4:8]))
	if respType == -1 {
		conn.Close()
		return nil, errors.New("rcon auth rejected")
	}
	_ = length
	return w, nil
}

// ---------------------------------------------------------------------------
// server.properties
// ---------------------------------------------------------------------------

type rconConfig struct {
	Enabled  bool
	Password string
}

func readServerProperties(dir string) rconConfig {
	path := filepath.Join(dir, "server.properties")
	data, err := os.ReadFile(path)
	if err != nil {
		return rconConfig{}
	}
	var cfg rconConfig
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch strings.TrimSpace(parts[0]) {
		case "enable-rcon":
			cfg.Enabled = strings.EqualFold(strings.TrimSpace(parts[1]), "true")
		case "rcon.password":
			cfg.Password = strings.TrimSpace(parts[1])
		case "rcon.port":
			if strings.TrimSpace(parts[1]) != strconv.Itoa(rconPort) {
				return rconConfig{} // port changed — treat as disabled
			}
		}
	}
	if !cfg.Enabled || cfg.Password == "" {
		return rconConfig{}
	}
	return cfg
}

// EnsureEnabled patches server.properties in place (works while the server is
// stopped). RCON binds to loopback so it is never exposed publicly on the host.
func EnsureEnabled(dir string) error {
	path := filepath.Join(dir, "server.properties")
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(string(data), "\n")
	} else {
		// Fall back to a minimal default when no properties file exists yet.
		lines = append(lines,
			"server-port=25565",
			"online-mode=true",
			"motd=UptimeHost Minecraft Server",
			"max-players=20",
			"view-distance=10",
			"spawn-protection=0",
		)
	}
	password := RandomPassword()
	if cur := readServerProperties(dir); cur.Password != "" {
		password = cur.Password
	}

	// Round-trip through a map preserving key order; unknown keys are kept.
	set := map[string]string{
		"enable-rcon":          "true",
		"rcon.port":            strconv.Itoa(rconPort),
		"rcon.bind":            "127.0.0.1",
		"rcon.password":        password,
	}
	out := make([]string, 0, len(lines)+4)
	seen := map[string]bool{}
	for _, line := range lines {
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			out = append(out, line)
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		key := strings.TrimSpace(parts[0])
		if v, ok := set[key]; ok {
			if !seen[key] {
				out = append(out, key+"="+v)
				seen[key] = true
			}
			continue
		}
		out = append(out, line)
	}
	for k, v := range set {
		if !seen[k] {
			out = append(out, k+"="+v)
		}
	}
	return os.WriteFile(path, []byte(strings.Join(out, "\n")+"\n"), 0o644)
}

// GuardRCONPort blocks external access to the RCON loopback port so a vanilla
// (non-rcon.bind) server is never reachable from the public network. Idempotent.
func GuardRCONPort(enabled bool) {
	ipt, err := execIptables()
	if err != nil {
		return
	}
	defer ipt.Close()
	rule := []string{"-A", "INPUT", "-p", "tcp", "--dport", strconv.Itoa(rconPort), "!", "-s", "127.0.0.1", "-j", "DROP", "-m", "comment", "--comment", "uh_rcon_loopback"}
	if !enabled {
		// Remove the rule (match while tolerating shell-quoted tokens).
		out, _ := ipt.Command("-S").Output()
		for _, line := range strings.Split(string(out), "\n") {
			if !strings.Contains(line, "uh_rcon_loopback") {
				continue
			}
			parts := strings.Fields(line)
			if len(parts) > 0 {
				parts = parts[1:] // drop "-A"
			}
			clean := make([]string, 0, len(parts))
			for _, p := range parts {
				clean = append(clean, strings.Trim(p, `"'`))
			}
			clean = append([]string{"-D"}, clean...)
			_ = ipt.Command(clean...).Run()
		}
		return
	}
	out, _ := ipt.Command("-S", "INPUT").Output()
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "uh_rcon_loopback") {
			return // already present
		}
	}
	if ec := ipt.Command(rule...).Run(); ec != nil {
		fmt.Printf("[players] guard rcon port: %v\n", ec)
	}
}

// RandomPassword returns a 32-char hex RCON secret.
func RandomPassword() string {
	const hex = "0123456789abcdef"
	b := make([]byte, 32)
	for i := range b {
		b[i] = hex[rand.Intn(len(hex))]
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// In-game actions over RCON
// ---------------------------------------------------------------------------

var actions = map[string]func(p string, args []string) string{
	"kick":        func(p string, _ []string) string { return "kick " + p },
	"ban":         func(p string, _ []string) string { return "ban " + p },
	"pardon":      func(p string, _ []string) string { return "pardon " + p },
	"whitelist":   func(p string, _ []string) string { return "whitelist add " + p },
	"dewhitelist": func(p string, _ []string) string { return "whitelist remove " + p },
	"op":          func(p string, _ []string) string { return "op " + p },
	"deop":        func(p string, _ []string) string { return "deop " + p },
	"teleport": func(p string, args []string) string {
		if len(args) > 0 {
			return "tp " + p + " " + args[0]
		}
		return "tp " + p + " 0 80 0"
	},
	"inventory":  func(p string, _ []string) string { return "data get entity " + p + " Inventory" },
	"enderchest": func(p string, _ []string) string { return "data get entity " + p + " EnderItems" },
}

// parseItems extracts item entries from a /data get entity response, e.g.
// "Inventory: [{id:"minecraft:diamond_sword",count:1,...}, ...]".
func parseItems(raw string) []Item {
	start := strings.Index(raw, "[")
	if start < 0 {
		return nil
	}
	end := strings.LastIndex(raw, "]")
	if end <= start {
		return nil
	}
	body := raw[start+1 : end]
	var items []Item
	// Split on top-level commas by naive brace tracking.
	parts := splitTop(body)
	for _, part := range parts {
		idRe := regexp.MustCompile(`id:"(?:minecraft:)?([a-z0-9_]+)"`)
		countRe := regexp.MustCompile(`count:(\d+)`)
		tagRe := regexp.MustCompile(`(tag:\{.*?\})`)
		slotRe := regexp.MustCompile(`Slot:(\d+)b`)
		m := idRe.FindStringSubmatch(part)
		if m == nil {
			continue
		}
		it := Item{ID: m[1]}
		if c := countRe.FindStringSubmatch(part); c != nil {
			it.Count, _ = strconv.Atoi(c[1])
		}
		if s := slotRe.FindStringSubmatch(part); s != nil {
			it.Slot, _ = strconv.Atoi(s[1])
		}
		if t := tagRe.FindStringSubmatch(part); t != nil {
			it.Tag = t[1]
		}
		items = append(items, it)
	}
	return items
}

func splitTop(s string) []string {
	var parts []string
	depth := 0
	cur := strings.Builder{}
	for _, r := range s {
		switch r {
		case '{', '[':
			depth++
		case '}', ']':
			depth--
		case ',':
			if depth == 0 {
				parts = append(parts, strings.TrimSpace(cur.String()))
				cur.Reset()
				continue
			}
		}
		cur.WriteRune(r)
	}
	if cur.Len() > 0 {
		parts = append(parts, strings.TrimSpace(cur.String()))
	}
	return parts
}

// ---------------------------------------------------------------------------
// Exec helpers
// ---------------------------------------------------------------------------

func execIptables() (ipt, error) {
	// Look up iptables on PATH (common location: /sbin/iptables).
	for _, p := range []string{"/sbin/iptables", "/usr/sbin/iptables", "iptables"} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return newIpt(p), nil
		}
	}
	return ipt{}, errors.New("iptables not found")
}

type ipt struct{ path string }

func newIpt(p string) ipt { return ipt{path: p} }
func (i ipt) Command(args ...string) *iptCmd {
	return &iptCmd{cmd: []string{i.path}, args: args}
}
func (i ipt) Close() {}

type iptCmd struct {
	cmd  []string
	args []string
}

func (c *iptCmd) Run() error { return runCmd(append(c.cmd, c.args...)) }

func (c *iptCmd) Output() ([]byte, error) { return outCmd(append(c.cmd, c.args...)) }

func runCmd(args []string) error {
	cmd := exec.Command(args[0], args[1:]...)
	return cmd.Run()
}

func outCmd(args []string) ([]byte, error) {
	cmd := exec.Command(args[0], args[1:]...)
	return cmd.Output()
}