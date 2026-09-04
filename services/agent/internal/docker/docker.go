// Package docker wraps the real Docker Engine API for container lifecycle,
// resource stats, command execution, log streaming and file operations.
package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/docker/docker/pkg/stdcopy"
)

// Manifest is what the Panel sends to create a server container.
type Manifest struct {
	ID         string            `json:"id"`         // stable server uuid -> container name
	Name       string            `json:"name"`       // friendly display name (container label)
	Image      string            `json:"image"`      // docker image ref
	Startup    []string          `json:"startup"`    // argv used at start
	Env        map[string]string `json:"env"`        // environment variables
	Ports      map[string]string `json:"ports"`      // "25565/tcp" -> hostPort
	MemoryMb   int64             `json:"memoryMb"`   // hard cap
	CPUPercent int64             `json:"cpuPercent"` // 50 = 0.5 core
	DiskMb     int64             `json:"diskMb"`     // storage quota (best effort)
	MountData  string            `json:"mountData"`  // host dir mounted at /home/container
	UID        int64             `json:"uid"`        // container runtime uid (chown the mount + set User)
}

type Client struct {
	cli *client.Client
	// stdin holds an open attach writer (to the container PID 1 stdin) per
	// managed container, so console commands can be sent straight to the
	// running server process (Pterodactyl-style) instead of spawning a shell.
	stdinMu sync.Mutex
	stdin   map[string]io.WriteCloser
}

func New() (*Client, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, fmt.Errorf("docker client: %w", err)
	}
	return &Client{cli: cli, stdin: map[string]io.WriteCloser{}}, nil
}

func (c *Client) Ping(ctx context.Context) error {
	_, err := c.cli.Ping(ctx)
	return err
}

// containerName derives a unique container name from a server uuid.
func containerName(id string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			return r
		}
		return '-'
	}, id)
	max := 48
	if len(clean) > max {
		clean = clean[:max]
	}
	return "uh_" + clean
}

// CopyStream holds a tar archive reader for file uploads.
type CopyStream struct {
	Reader io.Reader
	Mode   int64
}

// Request is the aggregate body the Panel sends for create.
func (c *Client) CreateContainer(ctx context.Context, m Manifest) (string, error) {
	name := containerName(m.ID)
	_, err := c.cli.ContainerInspect(ctx, name)
	if err == nil {
		return name, nil // already exists
	}

	// Pull image if not present locally.
	if err := c.ensureImage(ctx, m.Image); err != nil {
		return "", err
	}

	// --- expose ports (metadata) ---
	var exposed nat.PortSet = nat.PortSet{}
	for protoPort := range m.Ports {
		p, err := nat.NewPort("tcp", strings.Split(protoPort, "/")[0])
		if err != nil {
			continue
		}
		exposed[p] = struct{}{}
	}

	// --- parse memory + cpu ---
	memBytes := m.MemoryMb * 1024 * 1024
	var nanoCPUs int64
	if m.CPUPercent > 0 {
		// cpuPercent is percentage of one core (100 = 1 core)
		nanoCPUs = int64(float64(m.CPUPercent)/100.0*1e9)
	}

	hostCfg := &container.HostConfig{
		Binds:         []string{},
		PortBindings:  nil,
		NetworkMode:   "host",
		RestartPolicy: container.RestartPolicy{Name: "no"},
		Resources: container.Resources{
			Memory:     memBytes,
			NanoCPUs:   nanoCPUs,
			MemorySwap: memBytes,
		},
	}
	if m.MountData != "" {
		hostCfg.Binds = append(hostCfg.Binds, m.MountData+":/home/container")
	}

	env := []string{}
	for k, v := range m.Env {
		env = append(env, k+"="+v)
	}

	// Container runs as its own runtime uid so the data mount (chowned to the
	// same uid by the agent) is writable inside the container.
	uid := m.UID
	if uid <= 0 {
		uid = 1001
	}

	cfg := &container.Config{
		Image:        m.Image,
		Env:          env,
		ExposedPorts: exposed,
		Labels: map[string]string{
			"uptimehost.node": "1",
			"uptimehost.server.id": m.ID,
			"uptimehost.server.name": m.Name,
		},
		User:       fmt.Sprintf("%d:%d", uid, uid),
		WorkingDir: "/home/container",
		OpenStdin:  true,
	}
	if len(m.Startup) > 0 {
		cfg.Cmd = m.Startup
	}

	resp, err := c.cli.ContainerCreate(ctx, cfg, hostCfg, &network.NetworkingConfig{}, nil, name)
	if err != nil {
		return "", fmt.Errorf("container create: %w", err)
	}
	// Host networking binds directly to the host, so open the firewall for each
	// exposed port so external traffic can reach the server.
	for protoPort := range m.Ports {
		p, perr := nat.NewPort("tcp", strings.Split(protoPort, "/")[0])
		if perr != nil {
			continue
		}
		if perr = AllowPort(int(p.Int())); perr != nil {
			fmt.Printf("[docker] open firewall %s: %v\n", protoPort, perr)
		}
	}
	return resp.ID, nil
}

func (c *Client) ensureImage(ctx context.Context, ref string) error {
	if ref == "" {
		return errors.New("empty image reference")
	}
	_, _, err := c.cli.ImageInspectWithRaw(ctx, ref)
	if err == nil {
		return nil
	}
	rc, err := c.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("image pull %s: %w", ref, err)
	}
	// drain progress until close
	_, _ = io.Copy(io.Discard, rc)
	rc.Close()
	return nil
}

func (c *Client) Start(ctx context.Context, id string) error {
	return c.cli.ContainerStart(ctx, containerName(id), container.StartOptions{})
}
func (c *Client) Stop(ctx context.Context, id string) error {
	c.closeStdin(containerName(id))
	to := 20 // seconds grace
	return c.cli.ContainerStop(ctx, containerName(id), container.StopOptions{Timeout: &to})
}
func (c *Client) Restart(ctx context.Context, id string) error {
	c.closeStdin(containerName(id))
	to := 20
	return c.cli.ContainerRestart(ctx, containerName(id), container.StopOptions{Timeout: &to})
}
func (c *Client) Kill(ctx context.Context, id string) error {
	c.closeStdin(containerName(id))
	return c.cli.ContainerKill(ctx, containerName(id), "SIGKILL")
}
func (c *Client) Remove(ctx context.Context, id string) error {
	c.closeStdin(containerName(id))
	opts := container.RemoveOptions{Force: true, RemoveVolumes: true}
	return c.cli.ContainerRemove(ctx, containerName(id), opts)
}

func (c *Client) Exists(ctx context.Context, id string) bool {
	_, err := c.cli.ContainerInspect(ctx, containerName(id))
	return err == nil
}

// Info is a lightweight inspection result used by the Panel dashboard.
type Info struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Image     string            `json:"image"`
	State     string            `json:"state"`
	Status    string            `json:"status"`
	Created   string            `json:"created"`
	Ports     []Port            `json:"ports"`
	Labels    map[string]string `json:"labels"`
	StartedAt string            `json:"startedAt"`
}

type Port struct {
	IP       string `json:"ip"`
	HostPort string `json:"hostPort"`
	Type     string `json:"type"`
}

func (c *Client) Inspect(ctx context.Context, id string) (*Info, error) {
	insp, err := c.cli.ContainerInspect(ctx, containerName(id))
	if err != nil {
		return nil, err
	}
	info := &Info{
		ID:        insp.ID,
		Name:      strings.TrimPrefix(insp.Name, "/"),
		Image:     insp.Config.Image,
		State:     insp.State.Status,
		Status:    insp.State.Status,
		Created:   insp.Created,
		Labels:    insp.Config.Labels,
		StartedAt: insp.State.StartedAt,
	}
	for port, b := range insp.NetworkSettings.Ports {
		for _, pb := range b {
			info.Ports = append(info.Ports, Port{IP: pb.HostIP, HostPort: pb.HostPort, Type: port.Proto()})
		}
	}
	return info, nil
}

func (c *Client) State(ctx context.Context, id string) string {
	insp, err := c.cli.ContainerInspect(ctx, containerName(id))
	if err != nil {
		return "unknown"
	}
	return insp.State.Status
}

// Stats is a real point-in-time resource snapshot from the Docker API.
type Stats struct {
	ReadAt        float64            `json:"cpuPercent"`
	MemoryUsedMb  float64            `json:"memoryUsedMb"`
	MemoryLimitMb float64            `json:"memoryLimitMb"`
	MemoryPercent float64            `json:"memoryPercent"`
	NetworkRxMb   float64            `json:"networkRxMb"`
	NetworkTxMb   float64            `json:"networkTxMb"`
	Pids          uint64             `json:"pids"`
	BlockReadMb   float64            `json:"blockReadMb"`
	BlockWriteMb  float64            `json:"blockWriteMb"`
	Networks      map[string]NetStat `json:"networks"`
}

type NetStat struct {
	RxBytes uint64 `json:"rxBytes"`
	TxBytes uint64 `json:"txBytes"`
}

func (c *Client) Stats(ctx context.Context, id string) (*Stats, error) {
	out, err := c.cli.ContainerStats(ctx, containerName(id), false)
	if err != nil {
		return nil, fmt.Errorf("stats: %w", err)
	}
	defer out.Body.Close()
	body, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, err
	}
	var s types.StatsJSON
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, err
	}

	used := s.MemoryStats.Usage - s.MemoryStats.Stats["cache"]
	limit := s.MemoryStats.Limit
	st := &Stats{
		ReadAt:        cpuPercent(&s),
		MemoryUsedMb:  float64(used) / 1024 / 1024,
		MemoryLimitMb: float64(limit) / 1024 / 1024,
		Pids:          s.PidsStats.Current,
		Networks:      map[string]NetStat{},
	}
	if limit > 0 {
		st.MemoryPercent = float64(used) / float64(limit)
	}
	for _, e := range s.BlkioStats.IoServiceBytesRecursive {
		if e.Op == "Read" {
			st.BlockReadMb += float64(e.Value) / 1024 / 1024
		} else if e.Op == "Write" {
			st.BlockWriteMb += float64(e.Value) / 1024 / 1024
		}
	}
	for k, n := range s.Networks {
		st.Networks[k] = NetStat{RxBytes: n.RxBytes, TxBytes: n.TxBytes}
	}
	return st, nil
}

// cpuPercent derives CPU% from prev->current usage deltas.
func cpuPercent(s *types.StatsJSON) float64 {
	if s == nil || s.CPUStats.SystemUsage == 0 {
		return 0
	}
	curTotal := s.CPUStats.CPUUsage.TotalUsage
	prevTotal := s.PreCPUStats.CPUUsage.TotalUsage
	sysDelta := float64(s.CPUStats.SystemUsage - s.PreCPUStats.SystemUsage)
	if sysDelta <= 0 {
		return 0
	}
	cores := float64(len(s.CPUStats.CPUUsage.PercpuUsage))
	if cores == 0 {
		cores = 1
	}
	pct := (float64(curTotal-prevTotal) / sysDelta) * cores * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100*cores {
		pct = 100 * cores
	}
	return pct
}

// Exec runs a command inside the container (via a shell) and returns output.
func (c *Client) Exec(ctx context.Context, id, cmd string) (string, error) {
	exec, err := c.cli.ContainerExecCreate(ctx, containerName(id), types.ExecConfig{
		Cmd:          []string{"/bin/sh", "-c", cmd},
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		return "", err
	}
	hr, err := c.cli.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
	if err != nil {
		return "", err
	}
	defer hr.Close()
	// Parse Docker's multiplexed stdout/stderr frames into plain text.
	var buf bytes.Buffer
	_, _ = stdcopy.StdCopy(&buf, &buf, hr.Reader)
	return buf.String(), nil
}

// SendCommand writes a console command directly to the running container's
// stdin (PID 1), so it is consumed by the game server's console — exactly how
// Pterodactyl delivers console input. A background stdin attach is opened on
// first use and reused for the container's lifetime; it is torn down on stop.
// Returns (sent bool, err) so callers can fall back to Exec for truly shell
// commands when no stdin is available.
func (c *Client) SendCommand(ctx context.Context, id, cmd string) (bool, error) {
	name := containerName(id)
	w, err := c.stdinWriter(ctx, name)
	if err != nil {
		return false, err
	}
	if !strings.HasSuffix(cmd, "\n") {
		cmd += "\n"
	}
	if _, err := io.WriteString(w, cmd); err != nil {
		// The handle may have died; retry once with a fresh attach.
		c.stdinMu.Lock()
		delete(c.stdin, name)
		c.stdinMu.Unlock()
		w2, err2 := c.stdinWriter(ctx, name)
		if err2 != nil {
			return false, err
		}
		if _, err2 := io.WriteString(w2, cmd); err2 != nil {
			return false, err2
		}
	}
	return true, nil
}

// stdinWriter returns a reusable writer to the container's stdin, lazily
// attaching when missing. The attach streams only stdin (stdout/stderr are
// excluded to avoid duplicating the log stream); it stays open until the
// container stops, at which point the write fails and the handle is dropped.
func (c *Client) stdinWriter(ctx context.Context, name string) (io.WriteCloser, error) {
	c.stdinMu.Lock()
	defer c.stdinMu.Unlock()
	if w, ok := c.stdin[name]; ok {
		return w, nil
	}
	attach, err := c.cli.ContainerAttach(ctx, name, container.AttachOptions{
		Stream: true,
		Stdin:  true,
	})
	if err != nil {
		return nil, err
	}
	// Drain the attach so it does not block; only stdin is consumed here.
	go func() {
		_, _ = io.Copy(io.Discard, attach.Reader)
	}()
	c.stdin[name] = attach.Conn
	return attach.Conn, nil
}

// closeStdin drops any open stdin handle for a container (used on stop/kill).
func (c *Client) closeStdin(name string) {
	c.stdinMu.Lock()
	defer c.stdinMu.Unlock()
	if w, ok := c.stdin[name]; ok {
		_ = w.Close()
		delete(c.stdin, name)
	}
}

// Logs returns the last N lines of container output.
func (c *Client) Logs(ctx context.Context, id string, tail int) (string, error) {
	rc, err := c.cli.ContainerLogs(ctx, containerName(id), container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: "1000", Timestamps: false,
	})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	var buf bytes.Buffer
	_, _ = stdcopy.StdCopy(&buf, &buf, rc)
	return buf.String(), nil
}

// TarFromReader writes an uploaded (or arbitrary) reader as a tar whose sole
// entry is the given file content at name with mode. Used for file writes.
func TarBuffer(name, content string, mode int64) (*bytes.Buffer, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	hdr := &tar.Header{Name: name, Size: int64(len(content)), Mode: mode, Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		return nil, err
	}
	if _, err := tw.Write([]byte(content)); err != nil {
		return nil, err
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return &buf, nil
}

// ListContainerIDs returns all uptimehost-managed container names.
func (c *Client) ListAll(ctx context.Context) ([]string, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	var out []string
	for _, ct := range list {
		if ct.Labels["uptimehost.node"] == "1" {
			out = append(out, strings.TrimPrefix(ct.Names[0], "/"))
		}
	}
	return out, nil
}

// ContainerStatus is a single uptimehost container's live state.
type ContainerStatus struct {
	Name    string            `json:"name"`
	ID      string            `json:"id"`
	State   string            `json:"state"` // running | exited | created | ...
	Status  string            `json:"status"`
	Server  string            `json:"serverId"`
	Image   string            `json:"image"`
	Running bool              `json:"running"`
}

// ListContainers returns live states for all uptimehost-managed containers.
func (c *Client) ListContainers(ctx context.Context) ([]ContainerStatus, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	out := make([]ContainerStatus, 0)
	for _, ct := range list {
		if ct.Labels["uptimehost.node"] != "1" {
			continue
		}
		st := ContainerStatus{
			Name:  strings.TrimPrefix(ct.Names[0], "/"),
			ID:    ct.ID,
			State: ct.State,
			Status: ct.Status,
			Server: ct.Labels["uptimehost.server.id"],
			Image: ct.Image,
			Running: ct.State == "running",
		}
		out = append(out, st)
	}
	return out, nil
}

// Volume mount path is /home/container inside the container and MapHostPath
// maps an in-container path to a mount path using the data dir.
func (c *Client) ContainerName(id string) string { return containerName(id) }

// StreamLogs emits decoded stdout/stderr lines (historical + follow) via cb.
func (c *Client) StreamLogs(ctx context.Context, id string, tail string, since string, cb func(line []byte)) error {
	rc, err := c.cli.ContainerLogs(ctx, containerName(id), container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: true, Tail: tail, Since: since,
	})
	if err != nil {
		return err
	}
	// Ensure the follow stream is torn down if the caller cancels the context
	// (e.g. a restart re-anchors the console log stream).
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			_ = rc.Close()
		case <-done:
		}
	}()
	defer rc.Close()
	out := &lineCollector{send: cb}
	_, _ = stdcopy.StdCopy(out, out, rc)
	return nil
}

type lineCollector struct {
	send func([]byte)
}

func (l *lineCollector) Write(p []byte) (int, error) {
	for _, line := range bytes.Split(p, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		l.send(line)
	}
	return len(p), nil
}
