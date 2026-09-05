// Package config loads agent configuration from the environment.
package config

import "os"

type Config struct {
	// ListenAddr is the bind address for the inbound HTTP + WS API that the
	// Panel (control core) calls to manage Docker containers on this node.
	ListenAddr string
	// Token is the bearer token the Panel must present for every request.
	Token string
	// NodeID identifies this node in the Panel.
	NodeID string

	// Outbound control core reporting (agent -> panel).
	CoreURL       string // base URL of the panel's agent-ingest API
	CoreToken     string
	RegToken      string // one-time secret authorizing enrollment with the panel
	Scheme        string // http | https — how the panel should reach this agent
	Host          string // FQDN / IP the panel should use to reach this agent
	TLSCert       string // path to TLS cert (fullchain) when the agent listens on https
	TLSKey        string // path to TLS private key when the agent listens on https
	PollSeconds   int
	ContainerBase string // volume mount base dir for server data

	// Per-server SFTP access. UH_SFTP_ADDR is the bind address for the SSH/SFTP
	// server, UH_SFTP_AUTH_URL is the panel endpoint that validates credentials.
	SftpAddr    string
	SftpAuthURL string
}

func Load() Config {
	return Config{
		ListenAddr:    getenv("UH_AGENT_ADDR", ":7373"),
		Token:         getenv("UH_AGENT_TOKEN", "agent-secret"),
		NodeID:        getenv("UH_NODE_ID", "node-local"),
		CoreURL:       getenv("UH_CORE_URL", ""),
		CoreToken:     getenv("UH_CORE_TOKEN", ""),
		RegToken:      getenv("UH_REG_TOKEN", ""),
		Scheme:        getenv("UH_AGENT_SCHEME", "http"),
		Host:          getenv("UH_AGENT_HOST", ""),
		TLSCert:       getenv("UH_AGENT_TLS_CERT", ""),
		TLSKey:        getenv("UH_AGENT_TLS_KEY", ""),
		PollSeconds:   atoi(getenv("UH_POLL_INTERVAL", "5")),
		ContainerBase: getenv("UH_CONTAINER_BASE", "/tmp/uptimehost/data"),
		SftpAddr:      getenv("UH_SFTP_ADDR", ""),
		SftpAuthURL:   getenv("UH_SFTP_AUTH_URL", ""),
	}
}

func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func atoi(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
	}
	return n
}
