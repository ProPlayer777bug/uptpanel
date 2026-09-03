// Package signing implements short-lived, signed, replay-protected requests
// between the Panel and the Node Agent (Pterodactyl-style architecture).
//
// Every Panel -> Node request carries headers:
//
//	X-Node-ID     the node UUID being addressed
//	X-Request-ID  a unique request id (nonce) used for idempotency + replay
//	X-Timestamp   unix seconds at signing time
//	X-Signature   lowercase hex HMAC-SHA256 over the canonical string below
//
// The canonical signed string (one field per line):
//
//	<HTTP method>
//	<request path incl. query string>
//	<X-Request-ID>
//	<X-Timestamp>
//	<X-Node-ID>
//	<sha256 hex of the raw request body>
//
// The HMAC key is the node's shared secret (agent token). The agent verifies
// the node id, the timestamp against a small clock-skew window, and that the
// request id has not been seen before (replay protection).
package signing

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

// MaxSkewSeconds is the maximum allowed clock difference between panel and node.
const MaxSkewSeconds int64 = 300

// MaxWindowSeconds bounds how long a signed request stays valid from its
// timestamp; anything older is rejected even if it arrived within skew.
const MaxWindowSeconds int64 = 180

// Sign computes the lowercase-hex HMAC-SHA256 signature for a request.
func Sign(secret, method, path, requestID, nodeID string, timestamp int64, body []byte) string {
	canonical := CanonicalString(method, path, requestID, nodeID, timestamp, body)
	return Signature(secret, canonical)
}

// Signature HMAC-SHA256s the canonical string with the shared secret.
func Signature(secret, canonical string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// CanonicalString builds the exactly-once signed payload for a request.
func CanonicalString(method, path, requestID, nodeID string, timestamp int64, body []byte) string {
	return fmt.Sprintf("%s\n%s\n%s\n%d\n%s\n%s",
		method, path, requestID, timestamp, nodeID, BodyHash(body))
}

// BodyHash returns the lowercase hex sha256 of the request body.
func BodyHash(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// Result describes the outcome of verification.
type Result int

const (
	// ResultOK means the request passed every check.
	ResultOK Result = iota
	// ResultMissingHeaders means required signed headers were absent.
	ResultMissingHeaders
	// ResultBadNode means X-Node-ID did not match this node.
	ResultBadNode
	// ResultBadTimestamp means the timestamp fell outside the allowed window.
	ResultBadTimestamp
	// ResultBadSignature means the HMAC did not match.
	ResultBadSignature
	// ResultReplay means the request id was already seen within the window.
	ResultReplay
)

func (r Result) String() string {
	switch r {
	case ResultOK:
		return "ok"
	case ResultMissingHeaders:
		return "missing headers"
	case ResultBadNode:
		return "node id mismatch"
	case ResultBadTimestamp:
		return "timestamp outside window"
	case ResultBadSignature:
		return "signature mismatch"
	case ResultReplay:
		return "replay detected"
	}
	return "unknown"
}

// Verifier validates signed requests and guards against replay.
//
// It caches request ids seen within the replay window so an intercepted,
// validly-signed request cannot be replayed against other endpoints. The cache
// is bounded; stale entries are evicted as new ones arrive.
type Verifier struct {
	mu     sync.Mutex
	seen   map[string]int64 // requestID -> unix seconds first seen
	budget int
}

// NewVerifier returns a replay guard with a bounded nonce cache.
func NewVerifier(budget int) *Verifier {
	if budget <= 0 {
		budget = 4096
	}
	return &Verifier{
		seen:   make(map[string]int64),
		budget: budget,
	}
}

// Verify checks a signed request. result == ResultOK when it may be processed.
func (v *Verifier) Verify(nodeID, method, path, requestID, timestamp, signature string, secret string, body []byte, now time.Time) Result {
	if requestID == "" || timestamp == "" || signature == "" || nodeID == "" {
		return ResultMissingHeaders
	}
	ts, err := parseTS(timestamp)
	if err != nil {
		return ResultBadTimestamp
	}
	nowSec := now.Unix()
	if nowSec-ts > MaxSkewSeconds || ts-nowSec > MaxSkewSeconds {
		return ResultBadTimestamp
	}
	if nowSec-ts > MaxWindowSeconds {
		return ResultBadTimestamp
	}
	expected := Sign(secret, method, path, requestID, nodeID, ts, body)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return ResultBadSignature
	}
	if !v.markSeen(requestID, nowSec) {
		return ResultReplay
	}
	return ResultOK
}

// markSeen returns false if the id was already seen inside the replay window.
func (v *Verifier) markSeen(requestID string, nowSec int64) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if t, ok := v.seen[requestID]; ok && nowSec-t < MaxWindowSeconds {
		return false
	}
	if len(v.seen) >= v.budget {
		for k, t := range v.seen {
			if nowSec-t > MaxWindowSeconds {
				delete(v.seen, k)
			}
		}
	}
	v.seen[requestID] = nowSec
	return true
}

func parseTS(s string) (int64, error) {
	var v int64
	if _, err := fmt.Sscanf(s, "%d", &v); err != nil {
		return 0, err
	}
	return v, nil
}

// NewRequestID returns a random request id (nonce) using crypto/rand.
func NewRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("rq-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
