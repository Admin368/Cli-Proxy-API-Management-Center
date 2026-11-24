//go:build windows

package main

import (
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestWebServerHelper(t *testing.T) {
	if os.Getenv("CUSTOM_UI_TEST_HELPER") != "yes" {
		return
	}
	http.ListenAndServe("127.0.0.1:"+os.Getenv("CUSTOM_UI_TEST_PORT"), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("fixture")) }))
	os.Exit(0)
}
func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	return port
}
func waitFor(t *testing.T, predicate func() bool) {
	t.Helper()
	until := time.Now().Add(12 * time.Second)
	for time.Now().Before(until) {
		if predicate() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("condition did not become true")
}
func TestOwnedServerStartStopAndDuplicateStart(t *testing.T) {
	workspace := t.TempDir()
	os.WriteFile(filepath.Join(workspace, "package.json"), []byte("{}"), 0600)
	executable, _ := os.Executable()
	port := freePort(t)
	t.Setenv("CUSTOM_UI_TEST_HELPER", "yes")
	t.Setenv("CUSTOM_UI_TEST_PORT", strconv.Itoa(port))
	c := controller{command: func(config) []string { return []string{executable, "-test.run=^TestWebServerHelper$"} }}
	if err := c.configure(config{Workspace: workspace, Bun: executable, Port: port}); err != nil {
		t.Fatal(err)
	}
	if err := c.start(); err != nil {
		t.Fatal(err)
	}
	defer c.shutdown()
	waitFor(t, func() bool { return c.status().Running })
	first := c.status()
	if !first.Managed || first.PID == 0 {
		t.Fatal(first)
	}
	if err := c.start(); err != nil {
		t.Fatal(err)
	}
	if c.status().PID != first.PID {
		t.Fatal("duplicate server spawned")
	}
	if err := c.stop(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return !probe(urlFor(c.cfg)) })
	if c.status().Managed {
		t.Fatal("server still owned after stop")
	}
}
func TestExternalServerIsNeverStopped(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer other.Close()
	u, _ := url.Parse(other.URL)
	port, _ := strconv.Atoi(u.Port())
	c := controller{}
	c.configure(config{Port: port})
	if !c.status().Running || c.status().Managed {
		t.Fatal(c.status())
	}
	if c.start() == nil || c.stop() == nil {
		t.Fatal("external server accepted for start/stop")
	}
	if !probe(other.URL) {
		t.Fatal("external server was stopped")
	}
}
func TestResourceIsReadOnlyAndWritesRequirePost(t *testing.T) {
	for _, req := range []pluginapi.ManagementRequest{
		{Method: "GET", Path: "/v0/resource/plugins/custom-web-ui/panel", Query: url.Values{"action": {"start"}}},
		{Method: "GET", Path: "/v0/management/plugins/custom-web-ui/start"},
	} {
		raw, _ := json.Marshal(req)
		response, err := handleMethod("management.handle", raw)
		if err != nil {
			t.Fatal(err)
		}
		var env struct{ Result pluginapi.ManagementResponse }
		if json.Unmarshal(response, &env) != nil {
			t.Fatal("invalid response")
		}
		if req.Path == "/v0/management/plugins/custom-web-ui/start" && env.Result.StatusCode != 405 {
			t.Fatal(env.Result.StatusCode)
		}
		if server.job != 0 {
			t.Fatal("GET started a process")
		}
	}
}
