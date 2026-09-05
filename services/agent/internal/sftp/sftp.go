// Package sftp exposes per-server SFTP access on the agent.
//
// Each SFTP session is authenticated with a per-server password that the Panel
// validates (POST to AuthURL with AgentToken). Sessions are chrooted to the
// server's data directory (<BaseDir>/<serverID>): every path is resolved
// through backup.SafeResolve so clients can never escape the sandbox.
package sftp

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/pkg/sftp"
	"github.com/uptimehost/agent/internal/backup"
	"golang.org/x/crypto/ssh"
)

const hostKeyPerm = 0o600

// Server accepts inbound SSH/SFTP connections.
type Server struct {
	ListenAddr string // e.g. ":2022"
	BaseDir    string // parent directory of per-server chroots (<ContainerBase>)
	KeyPath    string // persisted host key path
	AuthURL    string // panel endpoint used to validate credentials
	AgentToken string // bearer token presented to the panel while authenticating

	once   sync.Once
	signer ssh.Signer
}

func New(listenAddr, baseDir, keyPath, authURL, agentToken string) *Server {
	return &Server{
		ListenAddr: listenAddr,
		BaseDir:    baseDir,
		KeyPath:    keyPath,
		AuthURL:    authURL,
		AgentToken: agentToken,
	}
}

// Start accepts SFTP connections until ctx is canceled or a fatal error
// occurs. The returned error is nil on a clean shutdown.
func (s *Server) Start(ctx context.Context) error {
	if _, err := s.hostSigner(); err != nil {
		return err
	}
	ln, err := net.Listen("tcp", s.ListenAddr)
	if err != nil {
		return err
	}
	log.Printf("sftp: listening on %s (chroot base %s, auth %s)", s.ListenAddr, s.BaseDir, s.AuthURL)
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			log.Printf("sftp: accept error: %v", err)
			continue
		}
		go s.serveConn(conn)
	}
}

func (s *Server) serveConn(nc net.Conn) {
	defer nc.Close()

	signer, err := s.hostSigner()
	if err != nil {
		return
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: s.checkPassword,
		MaxAuthTries:     4,
		ServerVersion:    "SSH-2.0-UptimeHost",
	}
	cfg.AddHostKey(signer)

	sc, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		log.Printf("sftp: handshake from %s rejected: %v", nc.RemoteAddr(), err)
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)

	log.Printf("sftp: session opened from %s for server %s", nc.RemoteAddr(), sc.User())
	for newChannel := range chans {
		if newChannel.ChannelType() != "session" {
			_ = newChannel.Reject(ssh.UnknownChannelType, "only sftp sessions are supported")
			continue
		}
		ch, chReqs, err := newChannel.Accept()
		if err != nil {
			continue
		}
		go s.runSession(ch, chReqs, sc.User())
	}
}

// checkPassword authenticates an SFTP user. The username is the server ID and
// the password is validated by the Panel.
func (s *Server) checkPassword(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
	if conn.User() == "" {
		return nil, errors.New("missing server id")
	}
	if !s.authorize(conn.User(), string(password)) {
		return nil, errors.New("invalid credentials")
	}
	return nil, nil
}

func (s *Server) authorize(serverID, password string) bool {
	if s.AuthURL == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()

	body, err := json.Marshal(map[string]string{"serverId": serverID, "password": password})
	if err != nil {
		return false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.AuthURL, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+s.AgentToken)
	req.Header.Set("Content-Type", "application/json")
	cli := &http.Client{Timeout: 5 * time.Second}

	resp, err := cli.Do(req)
	if err != nil {
		log.Printf("sftp: auth request to %s failed: %v", s.AuthURL, err)
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("sftp: auth request to %s returned %d", s.AuthURL, resp.StatusCode)
		return false
	}
	var out struct {
		Ok bool `json:"ok"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		log.Printf("sftp: auth response decode failed: %v", err)
		return false
	}
	return out.Ok
}

// runSession consumes channel requests until the sftp subsystem is started,
// then serves the SFTP protocol chrooted to the server data directory.
func (s *Server) runSession(ch ssh.Channel, reqs <-chan *ssh.Request, serverID string) {
	defer ch.Close()
	go func() { // drain any requests arriving after the subsystem starts
		for range reqs {
		}
	}()

	for req := range reqs {
		ok := false
		if req.Type == "subsystem" {
			name := ""
			if len(req.Payload) > 4 {
				name = string(req.Payload[4:])
			}
			ok = name == "sftp"
		}
		if req.Type == "pty-req" || req.Type == "shell" || req.Type == "exec" {
			ok = false // interactive terminal access is not supported
		}
		_ = req.Reply(ok, nil)
		if ok {
			break
		}
	}

	root := filepath.Join(s.BaseDir, serverID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		log.Printf("sftp: cannot prepare chroot %q: %v", root, err)
		return
	}

	h := &chrootHandlers{root: root}
	rs := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
	log.Printf("sftp: serving %s -> %s", serverID, root)
	if err := rs.Serve(); err != nil && !errors.Is(err, io.EOF) {
		log.Printf("sftp: session for %s ended: %v", serverID, err)
	}
}

// chrootHandlers implements the sftp.Handlers interfaces, resolving every
// client-supplied path against the server chroot via backup.SafeResolve.
type chrootHandlers struct {
	root string
}

func (c *chrootHandlers) resolve(name string) string {
	return backup.SafeResolve(c.root, name)
}

func (c *chrootHandlers) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	p := c.resolve(r.Filepath)
	if p == "" {
		return nil, sftp.ErrSSHFxNoSuchFile
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, fxErr(err)
	}
	return f, nil
}

func (c *chrootHandlers) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	p := c.resolve(r.Filepath)
	if p == "" {
		return nil, sftp.ErrSSHFxNoSuchFile
	}
	if dir := filepath.Dir(p); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fxErr(err)
		}
	}
	flags := os.O_WRONLY | os.O_CREATE
	of := r.Pflags()
	switch {
	case of.Append:
		flags |= os.O_APPEND
	case of.Trunc:
		flags |= os.O_TRUNC
	}
	if of.Excl {
		flags |= os.O_EXCL
	}
	f, err := os.OpenFile(p, flags, 0o644)
	if err != nil {
		return nil, fxErr(err)
	}
	return f, nil
}

func (c *chrootHandlers) Filecmd(r *sftp.Request) error {
	switch r.Method {
	case "Mkdir":
		p := c.resolve(r.Filepath)
		if p == "" {
			return sftp.ErrSSHFxNoSuchFile
		}
		return fxErr(os.MkdirAll(p, 0o755))

	case "Rmdir", "Remove":
		p := c.resolve(r.Filepath)
		if p == "" {
			return sftp.ErrSSHFxNoSuchFile
		}
		return fxErr(os.Remove(p))

	case "Rename", "PosixRename":
		from := c.resolve(r.Filepath)
		to := c.resolve(r.Target)
		if from == "" || to == "" {
			return sftp.ErrSSHFxNoSuchFile
		}
		return fxErr(os.Rename(from, to))

	case "Setstat":
		return c.setstat(r)

	case "Symlink", "Link":
		return sftp.ErrSSHFxOpUnsupported

	default:
		return sftp.ErrSSHFxOpUnsupported
	}
}

func (c *chrootHandlers) StatVFS(*sftp.Request) (*sftp.StatVFS, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(c.root, &st); err != nil {
		return nil, fxErr(err)
	}
	frsize := uint64(st.Frsize)
	if frsize == 0 {
		frsize = uint64(st.Bsize)
	}
	return &sftp.StatVFS{
		Bsize:   uint64(st.Bsize),
		Frsize:  frsize,
		Blocks:  st.Blocks,
		Bfree:   st.Bfree,
		Bavail:  st.Bavail,
		Files:   st.Files,
		Ffree:   st.Ffree,
		Favail:  st.Ffree,
		Fsid:    uint64(st.Fsid.X__val[0]),
		Namemax: 255,
	}, nil
}

func (c *chrootHandlers) setstat(r *sftp.Request) error {
	p := c.resolve(r.Filepath)
	if p == "" {
		return sftp.ErrSSHFxNoSuchFile
	}
	flags := r.AttrFlags()
	attrs := r.Attributes()
	if flags.Size {
		if err := os.Truncate(p, int64(attrs.Size)); err != nil {
			return fxErr(err)
		}
	}
	if flags.Permissions {
		if err := os.Chmod(p, attrs.FileMode().Perm()); err != nil {
			return fxErr(err)
		}
	}
	if flags.Acmodtime {
		if err := os.Chtimes(p, time.Unix(int64(attrs.Atime), 0), time.Unix(int64(attrs.Mtime), 0)); err != nil {
			return fxErr(err)
		}
	}
	return nil
}

func (c *chrootHandlers) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	p := c.resolve(r.Filepath)
	if p == "" {
		return nil, sftp.ErrSSHFxNoSuchFile
	}
	switch r.Method {
	case "List":
		dir, err := os.ReadDir(p)
		if err != nil {
			return nil, fxErr(err)
		}
		infos := make([]os.FileInfo, 0, len(dir))
		for _, e := range dir {
			if fi, err := e.Info(); err == nil {
				infos = append(infos, fi)
			} else {
				infos = append(infos, dirInfo{name: e.Name()})
			}
		}
		return &listerAt{infos: infos}, nil

	case "Stat", "Lstat":
		stat, err := os.Stat(p)
		if r.Method == "Lstat" {
			stat, err = os.Lstat(p)
		}
		if err != nil {
			return nil, fxErr(err)
		}
		return &listerAt{infos: []os.FileInfo{stat}}, nil

	default:
		return nil, sftp.ErrSSHFxOpUnsupported
	}
}

// listerAt satisfies sftp.ListerAt with lazy error surfacing.
type listerAt struct {
	infos []os.FileInfo
}

func (l *listerAt) ListAt(ls []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l.infos)) {
		return 0, io.EOF
	}
	end := int(offset) + len(ls)
	if end > len(l.infos) {
		end = len(l.infos)
	}
	n := copy(ls, l.infos[offset:end])
	if end < len(l.infos) {
		return n, nil
	}
	return n, io.EOF
}

// dirInfo is a minimal fallback entry when stat of a directory entry fails.
type dirInfo struct {
	name string
}

func (d dirInfo) Name() string  { return d.name }
func (d dirInfo) Size() int64   { return 0 }
func (d dirInfo) Mode() os.FileMode { return 0 }
func (d dirInfo) ModTime() time.Time { return time.Unix(0, 0) }
func (d dirInfo) IsDir() bool   { return false }
func (d dirInfo) Sys() any      { return nil }

func fxErr(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, os.ErrNotExist):
		return sftp.ErrSSHFxNoSuchFile
	case errors.Is(err, os.ErrPermission):
		return sftp.ErrSSHFxPermissionDenied
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return sftp.ErrSSHFxFailure
	}
	return err
}

// hostSigner loads the persisted host key or generates a new one.
func (s *Server) hostSigner() (ssh.Signer, error) {
	s.once.Do(func() {
		if b, err := os.ReadFile(s.KeyPath); err == nil {
			if k, err := ssh.ParsePrivateKey(b); err == nil {
				s.signer = k
			}
		}
		if s.signer == nil {
			_, priv, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				return
			}
			block, err := ssh.MarshalPrivateKey(priv, "")
			if err != nil {
				return
			}
			if dir := filepath.Dir(s.KeyPath); dir != "" && dir != "." {
				if err := os.MkdirAll(dir, 0o755); err != nil {
					return
				}
			}
			if err := os.WriteFile(s.KeyPath, pem.EncodeToMemory(block), hostKeyPerm); err != nil {
				return
			}
			s.signer, _ = ssh.NewSignerFromKey(priv)
		}
	})
	if s.signer == nil {
		return nil, errors.New("sftp: unable to load or generate host key")
	}
	return s.signer, nil
}