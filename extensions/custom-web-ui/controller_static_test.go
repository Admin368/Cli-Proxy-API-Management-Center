//go:build windows

package main

import (
	"strconv"
	"strings"
	"testing"
)

func TestStaticModeAutoStartStatusAndStop(t *testing.T) {
	workspace := t.TempDir()
	dist := writeDist(t)
	port := freeLoopbackPort(t)
	c := controller{}
	if err := c.configure(config{Workspace: workspace, DistDir: dist, Port: port, Mode: "static", AutoStart: true}); err != nil {
		t.Fatal(err)
	}
	c.autoStart()
	defer c.shutdown()
	st := c.status()
	if !st.Running || !st.Managed || st.Mode != "static" || len(st.URLs) != 1 || !strings.HasPrefix(st.URL, "http://127.0.0.1:") {
		t.Fatalf("status after auto-start: %+v", st)
	}
	if status, body, _ := get(t, "GET", st.URL); status != 200 || !strings.Contains(body, "dashboard") {
		t.Fatal("dashboard not served")
	}
	if err := c.start(); err != nil {
		t.Fatal("start while running must be idempotent:", err)
	}
	if err := c.stop(); err != nil {
		t.Fatal(err)
	}
	if st := c.status(); st.Running || st.Managed {
		t.Fatalf("status after stop: %+v", st)
	}
	if err := c.stop(); err == nil {
		t.Fatal("stop with nothing running must report it")
	}
}

func TestStaticModeReconfigureRestartsAndBadConfigIsReported(t *testing.T) {
	dist := writeDist(t)
	port := freeLoopbackPort(t)
	c := controller{}
	if err := c.configure(config{DistDir: dist, Port: port, Mode: "static"}); err != nil {
		t.Fatal(err)
	}
	if err := c.start(); err != nil {
		t.Fatal(err)
	}
	defer c.shutdown()
	newPort := freeLoopbackPort(t)
	if err := c.configure(config{DistDir: dist, Port: newPort, Mode: "static"}); err != nil {
		t.Fatal(err)
	}
	if st := c.status(); !st.Running || !strings.Contains(st.URL, ":"+strconv.Itoa(newPort)+"/") {
		t.Fatalf("server not restarted on the new port: %+v", st)
	}
	if err := c.configure(config{Mode: "bogus"}); err == nil {
		t.Fatal("unknown mode accepted")
	}
	if err := c.configure(config{Mode: "static", Listen: "0.0.0.0"}); err == nil {
		t.Fatal("unspecified listen address accepted")
	}
	broken := controller{}
	broken.configure(config{DistDir: t.TempDir(), Port: freeLoopbackPort(t), Mode: "static", AutoStart: true})
	broken.autoStart()
	if st := broken.status(); st.Running || !strings.Contains(st.Error, "Auto-start") {
		t.Fatalf("auto-start failure must be reported, not fatal: %+v", st)
	}
}
