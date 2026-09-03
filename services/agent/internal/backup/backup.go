// Package backup creates and extracts ZIP archives of a server's file tree
// on the node filesystem. It lives on the host so it does not depend on a
// running container, and it enforces strict path-traversal protection so a
// crafted archive or path can never escape the server's data directory.
package backup

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Create zips the directory root into dest (a file path). It returns the
// number of bytes written.
func Create(root, dest string) (int64, error) {
	info, err := os.Stat(root)
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, fmt.Errorf("backup source is not a directory")
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return 0, err
	}
	f, err := os.Create(dest)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	zw := zip.NewWriter(f)
	defer zw.Close()

	total, err := addDir(zw, root, root)
	if err != nil {
		return total, err
	}
	return total, nil
}

func addDir(zw *zip.Writer, root, base string) (int64, error) {
	var total int64
	entries, err := os.ReadDir(root)
	if err != nil {
		return total, err
	}
	for _, e := range entries {
		full := filepath.Join(root, e.Name())
		rel, err := filepath.Rel(base, full)
		if err != nil {
			return total, err
		}
		rel = filepath.ToSlash(rel)
		if e.IsDir() {
			hdr := &zip.FileHeader{Name: rel + "/", Method: zip.Deflate}
			if _, err := zw.CreateHeader(hdr); err != nil {
				return total, err
			}
			n, err := addDir(zw, full, base)
			total += n
			if err != nil {
				return total, err
			}
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		// Skip socket/fifo special files.
		if !info.Mode().IsRegular() {
			continue
		}
		hdr := &zip.FileHeader{Name: rel, Method: zip.Deflate}
		hdr.SetMode(info.Mode().Perm())
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return total, err
		}
		rc, err := os.Open(full)
		if err != nil {
			return total, err
		}
		n, err := io.Copy(w, rc)
		rc.Close()
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// Extract unpacks an archive into dest, refusing any entry that would escape
// dest (zip-slip protection).
func Extract(archive, dest string) (int64, error) {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return 0, err
	}
	r, err := zip.OpenReader(archive)
	if err != nil {
		return 0, err
	}
	defer r.Close()

	var total int64
	for _, zf := range r.File {
		name := filepath.FromSlash(zf.Name)
		if strings.Contains(name, "..") {
			return total, fmt.Errorf("archive contains unsafe path %q", zf.Name)
		}
		target := filepath.Join(dest, name)
		if !within(dest, target) {
			return total, fmt.Errorf("archive entry escapes root: %q", zf.Name)
		}
		if zf.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return total, err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return total, err
		}
		rc, err := zf.Open()
		if err != nil {
			return total, err
		}
		mode := zf.Mode()
		if mode == 0 {
			mode = 0o644
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			rc.Close()
			return total, err
		}
		n, err := io.Copy(out, rc)
		out.Close()
		rc.Close()
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// SafeResolve verifies that "name" stays within the given root and returns the
// absolute host path, or "" if the name is unsafe.
func SafeResolve(root, name string) string {
	if root == "" || name == "" {
		return ""
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return ""
	}
	clean := filepath.Clean(filepath.Join(absRoot, filepath.FromSlash(name)))
	if !within(absRoot, clean) {
		return ""
	}
	return clean
}

func within(root, target string) bool {
	rp, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rp == "." || (!strings.HasPrefix(rp, ".."+string(filepath.Separator)) && rp != "..")
}
