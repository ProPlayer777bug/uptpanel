// UptimeHost Node Agent — runs on each infrastructure node and manages Docker
// containers for game/application servers.
//
//   - Inbound Http + WebSocket API (the Panel calls this to control containers).
//   - Real Docker lifecycle, stats, logs and file operations.
//   - Optional outbound heartbeat to the Panel for node health tracking.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/uptimehost/agent/internal/config"
	"github.com/uptimehost/agent/internal/docker"
	"github.com/uptimehost/agent/internal/httpapi"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	dm, err := docker.New()
	if err != nil {
		log.Fatalf("agent: docker init failed: %v", err)
	}
	if err := dm.Ping(ctx); err != nil {
		log.Printf("agent: WARNING docker unreachable: %v (agent will stay up)", err)
	} else {
		log.Printf("agent: docker daemon reachable")
	}

	srv := httpapi.New(dm, cfg.Token, cfg.ContainerBase)
	httpSrv := &http.Server{
		Addr:    cfg.ListenAddr,
		Handler: srv.Routes(),
	}

	go func() {
		if cfg.TLSCert != "" && cfg.TLSKey != "" {
			log.Printf("agent: listening on https://%s (TLS)", cfg.ListenAddr)
			if err := httpSrv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey); err != nil && err != http.ErrServerClosed {
				log.Fatalf("agent: server: %v", err)
			}
			return
		}
		log.Printf("agent: listening on http://%s", cfg.ListenAddr)
		if err := httpSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("agent: server: %v", err)
		}
	}()

	// Optional outbound registration + heartbeat to the Panel for node presence
	// tracking. On startup this enrolls the agent (node can be installed on any
	// system and connect back to the panel) and then keeps reporting liveness.
	if cfg.CoreURL != "" {
		go heartbeat(ctx, cfg)
	}

	<-ctx.Done()
	shCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shCtx)
	log.Println("agent: stopped")
}

func heartbeat(ctx context.Context, cfg config.Config) {
	tick := time.NewTicker(time.Duration(cfg.PollSeconds) * time.Second)
	defer tick.Stop()

	host := cfg.Host
	if host == "" {
		host = "localhost"
	}
	port := cfg.ListenAddr
	if i := strings.LastIndex(port, ":"); i >= 0 {
		port = port[i+1:]
	}

	report := func(register bool) {
		payload := map[string]any{
			"nodeId": cfg.NodeID,
			"ts":     time.Now().UnixMilli(),
		}
		// On first call, enroll with the panel by advertising how to reach us
		// and presenting the one-time registration token.
		if register {
			payload["token"] = cfg.RegToken
			payload["scheme"] = cfg.Scheme
			payload["host"] = host
			payload["port"] = port
		}
		body, _ := json.Marshal(payload)
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, cfg.CoreURL, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+cfg.CoreToken)
		req.Header.Set("Content-Type", "application/json")
		cli := &http.Client{Timeout: 4 * time.Second}
		if resp, err := cli.Do(req); err == nil {
			buf := make([]byte, 256)
			n, _ := resp.Body.Read(buf)
			_ = resp.Body.Close()
			respBody := strings.TrimSpace(string(buf[:n]))
			if register {
				if resp.StatusCode == 200 {
					log.Printf("agent: enrolled with panel at %s (advertised %s://%s:%s)", cfg.CoreURL, cfg.Scheme, host, port)
				} else {
					log.Printf("agent: enrollment rejected (%d): %s", resp.StatusCode, respBody)
				}
			}
		}
	}
	// Register once immediately; then heartbeat.
	report(true)
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			report(false)
		}
	}
}
