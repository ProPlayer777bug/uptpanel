package httpapi

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// HostStat captures a point-in-time snapshot of host resource usage. The agent
// reports this from the panel's /api/system ping so the panel can render live
// node health without an out-of-band agent push.
type HostStat struct {
	CpuPercent   float64 `json:"cpuPercent"`
	MemoryBytes  uint64  `json:"memoryBytes"`
	MemoryUsed   uint64  `json:"memoryUsed"`
	MemoryPct    float64 `json:"memoryPercent"`
	DiskBytes    uint64  `json:"diskBytes"`
	DiskUsed     uint64  `json:"diskUsed"`
	DiskPct      float64 `json:"diskPercent"`
	DiskRoot     string  `json:"diskRoot"`
	Load1        float64 `json:"load1"`
	Load5        float64 `json:"load5"`
	Load15       float64 `json:"load15"`
	UptimeSec    uint64  `json:"uptimeSec"`
	OS           string  `json:"os"`
	Kernel       string  `json:"kernel"`
	CpuCores     int     `json:"cpuCores"`
	NetRxBytes   uint64  `json:"netRxBytes"`
	NetTxBytes   uint64  `json:"netTxBytes"`
}

const (
	sysCPUStat     = "/proc/stat"
	sysMemInfo     = "/proc/meminfo"
	sysLoadAvg     = "/proc/loadavg"
	sysUptime      = "/proc/uptime"
	sysNetDev      = "/proc/net/dev"
)

var collectCpu *cpuSample

type cpuSample struct {
	idle  uint64
	total uint64
	at    time.Time
}

// ReadHostStats gathers a host resource snapshot. It never returns an error so
// a partial collection can still populate the panel with whatever is available.
func ReadHostStats() (HostStat, error) {
	var h HostStat
	h.CpuCores = runtime.NumCPU()
	h.OS = runtime.GOOS
	h.Kernel = readKernel()
	h.Load1, h.Load5, h.Load15 = readLoad()
	h.UptimeSec = readUptime()
	h.DiskRoot = "/"
	h.MemoryBytes, h.MemoryUsed, h.MemoryPct = readMem()
	h.CpuPercent = readCPU()
	total, used, pct, root := readDisk("/")
	h.DiskBytes, h.DiskUsed, h.DiskPct, h.DiskRoot = total, used, pct, root
	h.NetRxBytes, h.NetTxBytes = readNet()
	return h, nil
}

func readKernel() string {
	b, err := os.ReadFile("/proc/version")
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(b))
	// /proc/version format: "Linux version 5.15.0-... (gcc ...)"
	if len(fields) >= 3 {
		return fields[2]
	}
	return strings.TrimSpace(string(b))
}

func readLoad() (float64, float64, float64) {
	b, err := os.ReadFile(sysLoadAvg)
	if err != nil {
		return 0, 0, 0
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return 0, 0, 0
	}
	v := func(s string) float64 { x, _ := strconv.ParseFloat(s, 64); return x }
	return v(f[0]), v(f[1]), v(f[2])
}

func readUptime() uint64 {
	b, err := os.ReadFile(sysUptime)
	if err != nil {
		return 0
	}
	f := strings.Fields(string(b))
	if len(f) < 1 {
		return 0
	}
	sec, _ := strconv.ParseUint(f[0], 10, 64)
	return sec
}

func readMem() (total, used uint64, pct float64) {
	lines, err := readLines(sysMemInfo)
	if err != nil {
		return 0, 0, 0
	}
	kv := map[string]uint64{}
	keys := []string{"MemTotal", "MemFree", "MemAvailable", "Buffers", "Cached", "SReclaimable", "Shmem"}
	for _, ln := range lines {
		for _, k := range keys {
			if strings.HasPrefix(ln, k+":") {
				f := strings.Fields(strings.TrimPrefix(ln, k+":"))
				if len(f) >= 1 {
					v, _ := strconv.ParseUint(f[0], 10, 64)
					kv[k] = v
				}
			}
		}
	}
	total = kv["MemTotal"] * 1024
	buffers := kv["Buffers"] * 1024
	cached := (kv["Cached"] + kv["SReclaimable"] - kv["Shmem"]) * 1024
	if kv["MemAvailable"] > 0 {
		available := kv["MemAvailable"] * 1024
		used = 0
		if total > available {
			used = total - available
		}
		if total == 0 {
			return 0, 0, 0
		}
		return total, used, float64(used) / float64(total) * 100
	}
	used = total - kv["MemFree"]*1024 - buffers - cached
	if total == 0 {
		return 0, 0, 0
	}
	if used > total {
		used = total
	}
	return total, used, float64(used) / float64(total) * 100
}

func readCPU() float64 {
	lines, err := readLines(sysCPUStat)
	if err != nil {
		return 0
	}
	var total, idle uint64
	for _, ln := range lines {
		if !strings.HasPrefix(ln, "cpu ") {
			continue
		}
		f := strings.Fields(ln)
		for i, v := range f[1:] {
			n, _ := strconv.ParseUint(v, 10, 64)
			total += n
			if i == 3 { // idle
				idle = n
			}
		}
	}
	now := time.Now()
	var pct float64
	if collectCpu != nil && total > collectCpu.total && now.Sub(collectCpu.at).Seconds() > 0 {
		dtotal := total - collectCpu.total
		didle := idle - collectCpu.idle
		if dtotal > 0 {
			pct = (1 - float64(didle)/float64(dtotal)) * 100
		}
	}
	collectCpu = &cpuSample{idle: idle, total: total, at: now}
	return pct
}

func readDisk(path string) (total, used uint64, pct float64, root string) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, 0, path
	}
	total = st.Blocks * uint64(st.Bsize)
	avail := st.Bavail * uint64(st.Bsize)
	used = total - avail
	if total == 0 {
		return 0, 0, 0, path
	}
	// free = total - used for the root mount
	return total, used, float64(used) / float64(total) * 100, path
}

func readNet() (rx, tx uint64) {
	lines, err := readLines(sysNetDev)
	if err != nil {
		return 0, 0
	}
	for _, ln := range lines {
		if !strings.Contains(ln, ":") || strings.HasPrefix(strings.TrimSpace(ln), "lo") {
			continue
		}
		parts := strings.SplitN(ln, ":", 2)
		if len(parts) != 2 {
			continue
		}
		f := strings.Fields(parts[1])
		if len(f) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(f[0], 10, 64)
		t, _ := strconv.ParseUint(f[8], 10, 64)
		rx += r
		tx += t
	}
	return rx, tx
}

func readLines(p string) ([]string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return nil, nil
	}
	return strings.Split(s, "\n"), nil
}

func diskUsage(p string) (used uint64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0
	}
	avail := st.Bavail * uint64(st.Bsize)
	return st.Blocks*uint64(st.Bsize) - avail
}
