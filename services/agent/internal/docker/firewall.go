package docker

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// AllowPort opens a TCP port in the host firewall (ufw) and persists the rule,
// so it also applies if ufw is enabled later. Host-networked containers bind
// directly to the host, so the panel must explicitly open/close each port.
func AllowPort(port int) error {
	return ufwCmd("allow", port)
}

// DisallowPort closes a TCP port previously opened with AllowPort.
func DisallowPort(port int) error {
	return ufwCmd("delete allow", port)
}

func ufwCmd(action string, port int) error {
	if port <= 0 || port > 65535 {
		return fmt.Errorf("invalid port %d", port)
	}
	if _, err := exec.LookPath("ufw"); err != nil {
		// ufw not installed on the node — nothing to open/close, not fatal.
		return nil
	}
	args := append(strings.Fields(action), strconv.Itoa(port)+"/tcp")
	out, err := exec.Command("ufw", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("ufw %s %d: %s (%v)", action, port, strings.TrimSpace(string(out)), err)
	}
	return nil
}
