package docker

import (
	"fmt"
	"hash/crc32"
	"os/exec"
	"sort"
	"strconv"
	"strings"
)

// AntiDdos protection is host-side, per-server traffic filtering applied to a
// server's game port(s). The rules live in a dedicated iptables chain jumped to
// at the very top of INPUT (above ufw's generic allow rules), so an excessive
// number of new connections or packets from a single source IP is dropped
// before it can saturate the game process. Legitimate players are unaffected —
// filter thresholds are well above normal play (Minecraft clients keep 1-2
// connections; even large UDP games stay under 100 pkt/s per IP).
//
// Levels tune the thresholds:
//
//	standard:  10 new TCP conns/s (burst 25), 40 concurrent conns/IP, 300 UDP pkt/s (burst 800)
//	strict:     5 new TCP conns/s (burst 15), 15 concurrent conns/IP, 120 UDP pkt/s (burst 300)
//
// SetAntiDdos is declarative per server and idempotent: it removes any existing
// rules tagged for the server (by iptables comment) before applying the desired
// state, so repeated calls never stack duplicate rules.

const antiddosChain = "UH-ANTIDDOS"

// AntiDdosLevel names a protection profile. Keys must stay in sync with the panel.
type AntiDdosLevel string

const (
	LevelStandard AntiDdosLevel = "standard"
	LevelStrict   AntiDdosLevel = "strict"
)

type ddosThresholds struct {
	tcpNewAbove int
	tcpNewBurst int
	connLimit   int
	udpAbove    int
	udpBurst    int
}

func thresholdsFor(level AntiDdosLevel) ddosThresholds {
	if level == LevelStrict {
		return ddosThresholds{tcpNewAbove: 5, tcpNewBurst: 15, connLimit: 15, udpAbove: 120, udpBurst: 300}
	}
	return ddosThresholds{tcpNewAbove: 10, tcpNewBurst: 25, connLimit: 40, udpAbove: 300, udpBurst: 800}
}

// AntiDdosConfig is the desired anti-DDoS state for one server.
type AntiDdosConfig struct {
	ServerID string
	Ports    []int
	Enabled  bool
	Level    AntiDdosLevel
}

// serverComment is the iptables comment tag identifying rules owned by a server.
func serverComment(serverID string) string { return "uh_ddos:" + serverID }

// hashlimitName derives a short unique hashlimit bucket name from a server id.
func hashlimitName(serverID, suffix string) string {
	sum := crc32.ChecksumIEEE([]byte(serverID))
	return fmt.Sprintf("uhd_%08x_%s", sum, suffix)
}

// SetAntiDdos applies or removes DoS filtering for the given server's ports.
func SetAntiDdos(cfg AntiDdosConfig) error {
	ensureChain := func() error {
		if _, err := exec.LookPath("iptables"); err != nil {
			return nil // no iptables on the node — nothing to configure
		}
		if _, err := exec.Command("iptables", "-L", antiddosChain, "-n").CombinedOutput(); err != nil {
			// chain missing -> create
			if out, err := exec.Command("iptables", "-N", antiddosChain).CombinedOutput(); err != nil {
				return fmt.Errorf("iptables -N %s: %s (%v)", antiddosChain, strings.TrimSpace(string(out)), err)
			}
			// jump from the top of INPUT so filtering happens before ufw allows
			out, err := exec.Command("iptables", "-I", "INPUT", "1", "-j", antiddosChain).CombinedOutput()
			if err != nil {
				return fmt.Errorf("iptables -I INPUT -j %s: %s (%v)", antiddosChain, strings.TrimSpace(string(out)), err)
			}
		}
		return nil
	}
	if err := ensureChain(); err != nil {
		return err
	}

	// Idempotency: drop any existing rules tagged for this server first.
	if err := removeServerRules(cfg.ServerID); err != nil {
		return err
	}

	if cfg.Enabled {
		ports := normalPorts(cfg.Ports)
		if len(ports) == 0 {
			return fmt.Errorf("antiddos: no ports to protect for %s", cfg.ServerID)
		}
		dports := multiportSpec(ports)
		t := thresholdsFor(cfg.Level)
		tag := serverComment(cfg.ServerID)
		rules := [][]string{
			{"-p", "tcp", "-m", "multiport", "--dports", dports, "-m", "conntrack", "--ctstate", "NEW",
				"-m", "hashlimit", "--hashlimit-above", fmt.Sprintf("%d/sec", t.tcpNewAbove), "--hashlimit-burst",
				strconv.Itoa(t.tcpNewBurst), "--hashlimit-mode", "srcip",
				"--hashlimit-name", hashlimitName(cfg.ServerID, "new"),
				"-m", "comment", "--comment", tag, "-j", "DROP"},
			{"-p", "tcp", "-m", "multiport", "--dports", dports,
				"-m", "connlimit", "--connlimit-above", strconv.Itoa(t.connLimit), "--connlimit-mask", "32",
				"-m", "comment", "--comment", tag, "-j", "REJECT", "--reject-with", "tcp-reset"},
			{"-p", "udp", "-m", "multiport", "--dports", dports,
				"-m", "hashlimit", "--hashlimit-above", fmt.Sprintf("%d/sec", t.udpAbove), "--hashlimit-burst",
				strconv.Itoa(t.udpBurst), "--hashlimit-mode", "srcip",
				"--hashlimit-name", hashlimitName(cfg.ServerID, "udp"),
				"-m", "comment", "--comment", tag, "-j", "DROP"},
		}
		for _, spec := range rules {
			args := append([]string{"-A", antiddosChain}, spec...)
			if out, err := exec.Command("iptables", args...).CombinedOutput(); err != nil {
				return fmt.Errorf("iptables rule for %s: %s (%v)", cfg.ServerID, strings.TrimSpace(string(out)), err)
			}
		}
	}

	// If the chain holds no rules any more, tear it down so an all-off state
	// leaves no residue in INPUT.
	if chainEmpty() {
		if out, err := exec.Command("iptables", "-D", "INPUT", "-j", antiddosChain).CombinedOutput(); err == nil {
			_, _ = exec.Command("iptables", "-F", antiddosChain).CombinedOutput()
			_, _ = exec.Command("iptables", "-X", antiddosChain).CombinedOutput()
		} else {
			_ = out
		}
	}
	return nil
}

// removeServerRules deletes every rule in the anti-DDoS chain tagged for a
// server id. Rules are matched by iptables' own -S reconstruction so removal is
// exact regardless of the port set currently configured.
func removeServerRules(serverID string) error {
	tag := serverComment(serverID)
	out, err := exec.Command("iptables", "-S", antiddosChain).CombinedOutput()
	if err != nil {
		// Chain absent means nothing to remove.
		return nil
	}
	var dead [][]string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, tag) {
			dead = append(dead, cleanRuleSpec(line))
		}
	}
	for _, spec := range dead {
		args := append([]string{"-D", antiddosChain}, spec...)
		if err := exec.Command("iptables", args...).Run(); err != nil {
			return fmt.Errorf("iptables remove rule for %s: %w", serverID, err)
		}
	}
	return nil
}

// cleanRuleSpec converts one iptables -S rule line into a valid -D spec.
// -S reconstructs the rule with explicit -m and quoted display strings (e.g.
// --comment "uh_ddos:..."); the surrounding quotes are part of the token and
// must be stripped so the argument matches the value stored in the kernel.
func cleanRuleSpec(line string) []string {
	fields := strings.Fields(line)
	if len(fields) < 3 || fields[0] != "-A" {
		return nil
	}
	spec := fields[2:]
	for i, tok := range spec {
		spec[i] = strings.Trim(tok, `"`)
	}
	return spec
}

// chainEmpty reports whether the anti-DDoS chain currently holds no rules
// (only its -N definition remains, or it does not exist at all).
func chainEmpty() bool {
	out, err := exec.Command("iptables", "-S", antiddosChain).CombinedOutput()
	if err != nil {
		return true
	}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "-A ") {
			return false
		}
	}
	return true
}

// AntiDdosStatus returns whether a server currently has filtering applied and
// the protected ports, by scanning the chain for the server's comment tag.
func AntiDdosStatus(serverID string) (enabled bool, ports []int) {
	out, err := exec.Command("iptables", "-S", antiddosChain).CombinedOutput()
	if err != nil {
		return false, nil
	}
	seen := map[int]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		if !strings.Contains(line, serverComment(serverID)) {
			continue
		}
		enabled = true
		if v := indexAfterFlag(line, "--dports"); v != "" {
			for _, p := range strings.Split(v, ",") {
				if n, err := strconv.Atoi(strings.TrimSpace(p)); err == nil && n > 0 && !seen[n] {
					seen[n] = true
					ports = append(ports, n)
				}
			}
		}
	}
	sort.Ints(ports)
	return enabled, ports
}

func indexAfterFlag(line, flag string) string {
	f := strings.Fields(line)
	for i, tok := range f {
		if tok == flag && i+1 < len(f) {
			return f[i+1]
		}
	}
	return ""
}

// normalPorts returns unique, valid ports in ascending order.
func normalPorts(ports []int) []int {
	seen := map[int]bool{}
	out := make([]int, 0, len(ports))
	for _, p := range ports {
		if p > 0 && p <= 65535 && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	sort.Ints(out)
	return out
}

func multiportSpec(ports []int) string {
	s := make([]string, len(ports))
	for i, p := range ports {
		s[i] = strconv.Itoa(p)
	}
	return strings.Join(s, ",")
}