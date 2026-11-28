//go:build windows

package main

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

func lifecycle(t *testing.T, method, yamlText string) error {
	t.Helper()
	raw, _ := json.Marshal(lifecycleRequest{ConfigYAML: []byte(yamlText)})
	_, err := handleMethod(method, raw)
	return err
}

func TestLifecycleAutoStartAndAtomicReconfigure(t *testing.T) {
	defer func() { server.shutdown(); server = controller{} }()
	dist := writeDist(t)
	port := freeLoopbackPort(t)
	base := "mode: static\nauto_start: true\ndist_dir: " + strconv.Quote(dist) + "\nport: " + strconv.Itoa(port) + "\n"
	if err := lifecycle(t, pluginabi.MethodPluginRegister, base); err != nil {
		t.Fatal(err)
	}
	if !server.status().Running {
		t.Fatal("register with auto_start must start the server")
	}
	if err := server.stop(); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle(t, pluginabi.MethodPluginReconfigure, base); err != nil {
		t.Fatal(err)
	}
	if server.status().Managed {
		t.Fatal("reconfigure restarted a server the user stopped")
	}
	otherPort := freeLoopbackPort(t)
	bad := "mode: static\nauto_start: true\ndist_dir: " + strconv.Quote(dist) + "\nport: " + strconv.Itoa(otherPort) + "\nusage_database: relative.db\n"
	if err := lifecycle(t, pluginabi.MethodPluginReconfigure, bad); err == nil {
		t.Fatal("relative usage_database accepted")
	}
	if server.cfg.Port != port {
		t.Fatal("rejected configuration was partly applied")
	}
	off := "mode: static\nauto_start: false\ndist_dir: " + strconv.Quote(dist) + "\nport: " + strconv.Itoa(port) + "\n"
	lifecycle(t, pluginabi.MethodPluginReconfigure, off)
	if err := lifecycle(t, pluginabi.MethodPluginReconfigure, base); err != nil {
		t.Fatal(err)
	}
	if !server.status().Running {
		t.Fatal("switching auto_start on must start the server")
	}
}

func TestStaticStartIgnoresLoopbackWhenNotListening(t *testing.T) {
	busy := freeLoopbackPort(t)
	// Something unrelated answers on 127.0.0.1:<port>; listen uses another loopback address only.
	external := newFixtureServer(t, busy)
	defer external.Close()
	c := controller{}
	if err := c.configure(config{DistDir: writeDist(t), Port: busy, Mode: "static", Listen: "127.0.0.2"}); err != nil {
		t.Fatal(err)
	}
	defer c.shutdown()
	if err := c.start(); err != nil {
		t.Fatal("unrelated loopback service blocked a 127.0.0.2-only start:", err)
	}
	if st := c.status(); !st.Running || !strings.Contains(st.URL, "127.0.0.2") {
		t.Fatalf("status: %+v", st)
	}
}

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
