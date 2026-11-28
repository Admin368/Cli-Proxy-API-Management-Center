//go:build windows

package main

import (
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// FILE_NAME_NORMALIZED | VOLUME_NAME_DOS (both 0); x/sys does not export them.
const finalPathNormalizedDOS = 0

// finalPath returns the path the filesystem actually opened: long names
// (not 8.3 short names such as ENV~1) with symlinks and junctions resolved.
func finalPath(f *os.File) (string, error) {
	handle := windows.Handle(f.Fd())
	buf := make([]uint16, windows.MAX_PATH)
	for {
		n, err := windows.GetFinalPathNameByHandle(handle, &buf[0], uint32(len(buf)), finalPathNormalizedDOS)
		if err != nil {
			return "", err
		}
		if int(n) < len(buf) {
			p := windows.UTF16ToString(buf[:n])
			if strings.HasPrefix(p, `\\?\UNC\`) {
				return `\\` + p[len(`\\?\UNC\`):], nil
			}
			return strings.TrimPrefix(p, `\\?\`), nil
		}
		buf = make([]uint16, n+1)
	}
}
