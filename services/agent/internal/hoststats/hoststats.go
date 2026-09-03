// Package hoststats reads lightweight host resource usage (CPU, memory, disk)
// on Linux so the node agent can report load in its heartbeat. Values are
// percentages (0-100). On non-Linux platforms it falls back to zeroes without
// failing.
package hoststats

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Sample is a point-in-time resource reading for the node.
type Sample struct {
	CPU    float64 // percent used (0-100)
	Memory float64 // percent used (0-100)
	Disk   float64 // percent used (0-100)
}

// Collect returns current host CPU, memory and disk usage percentages.
func Collect() Sample {
	s := Sample{
		CPU:    cpuPercent(),
		Memory: memoryPercent(),
		Disk:   diskPercent("/"),
	}
	return s
}

func cpuPercent() float64 {
	// Read cumulative idle + total from /proc/stat over a short sample.
	a1, i1 := cpuFields()
	if a1 == 0 {
		return 0
	}
	time.Sleep(200 * time.Millisecond)
	a2, i2 := cpuFields()
	if a2 == 0 {
		return 0
	}
	dt := a2 - a1
	if dt <= 0 {
		return 0
	}
	return 100 * (1 - float64(i2-i1)/float64(dt))
}

// cpuFields returns (total_ticks, idle_ticks) for "cpu" aggregate line.
func cpuFields() (float64, float64) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		total := 0.0
		for _, v := range f[1:] {
			if n, e := strconv.ParseFloat(v, 64); e == nil {
				total += n
			}
		}
		idle, _ := strconv.ParseFloat(f[4], 64) // idle (field 4) + iowait field 5 optional
		return total, idle
	}
	return 0, 0
}

func memoryPercent() float64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	total, used := 0.0, 0.0
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		val, e := strconv.ParseFloat(f[1], 64)
		if e != nil {
			continue
		}
		switch f[0] {
		case "MemTotal:":
			total = val
		case "MemAvailable:":
			// used = total - available
			if total > 0 {
				used = total - val
			}
		}
	}
	if total <= 0 {
		return 0
	}
	return clamp(100 * used / total)
}

func diskPercent(path string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	if total == 0 {
		return 0
	}
	return clamp(100 * float64(total-free) / float64(total))
}

func clamp(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
