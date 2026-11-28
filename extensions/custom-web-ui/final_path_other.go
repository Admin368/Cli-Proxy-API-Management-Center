//go:build !windows

package main

import (
	"os"
	"path/filepath"
)

// finalPath returns the opened file's path with symlinks resolved.
func finalPath(f *os.File) (string, error) {
	return filepath.EvalSymlinks(f.Name())
}
