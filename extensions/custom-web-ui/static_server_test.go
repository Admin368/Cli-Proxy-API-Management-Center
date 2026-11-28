package main

import (
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func writeDist(t *testing.T) string {
	t.Helper()
	dist := t.TempDir()
	os.MkdirAll(filepath.Join(dist, "assets"), 0o700)
	os.WriteFile(filepath.Join(dist, "index.html"), []byte("<html>dashboard</html>"), 0o600)
	os.WriteFile(filepath.Join(dist, "assets", "app.js"), []byte("console.log(1)"), 0o600)
	os.WriteFile(filepath.Join(dist, ".env"), []byte("SECRET=1"), 0o600)
	return dist
}

func get(t *testing.T, method, rawURL string) (int, string, http.Header) {
	t.Helper()
	req, _ := http.NewRequest(method, rawURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, "", nil
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body), resp.Header
}

func freeLoopbackPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func TestStaticServerServesOnlyTheBuiltDashboard(t *testing.T) {
	dist := writeDist(t)
	port := freeLoopbackPort(t)
	var s staticServer
	if err := s.start(dist, port, []string{"127.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	defer s.stop()
	base := "http://127.0.0.1:" + strconv.Itoa(port)
	cases := []struct {
		path   string
		status int
		body   string
	}{
		{"/", 200, "dashboard"},
		{"/quota/forecast", 200, "dashboard"},
		{"/assets/app.js", 200, "console.log"},
		{"/.env", 404, ""},
		{"/assets/../.env", 404, ""},
		{"/%2e%2e/%2e%2e/windows/win.ini", 404, ""},
		{"/missing.js", 404, ""},
	}
	for _, c := range cases {
		status, body, _ := get(t, "GET", base+c.path)
		if status != c.status || !strings.Contains(body, c.body) {
			t.Fatalf("%s: got %d %q", c.path, status, body)
		}
	}
	if status, _, h := get(t, "GET", base+"/assets/app.js"); status != 200 || !strings.Contains(h.Get("Cache-Control"), "immutable") || h.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("asset headers missing")
	}
	if _, _, h := get(t, "GET", base+"/"); h.Get("Cache-Control") != "no-cache" {
		t.Fatal("index must not be cached")
	}
	if status, _, _ := get(t, "POST", base+"/"); status != 405 {
		t.Fatal("POST must be rejected")
	}
	if st := s.status(); !st.Active || len(st.Bound) != 1 || len(st.Pending) != 0 {
		t.Fatalf("status: %+v", st)
	}
	if !s.stop() {
		t.Fatal("stop reported nothing running")
	}
	if status, _, _ := get(t, "GET", base+"/"); status != 0 {
		t.Fatal("server still answering after stop")
	}
	if s.stop() {
		t.Fatal("second stop must be a no-op")
	}
}

func TestStaticServerRetriesBusyAddressUntilFree(t *testing.T) {
	previous := staticRetryInterval
	staticRetryInterval = 100 * time.Millisecond
	defer func() { staticRetryInterval = previous }()
	dist := writeDist(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := busy.Addr().(*net.TCPAddr).Port
	var s staticServer
	if err := s.start(dist, port, []string{"127.0.0.1"}); err != nil {
		t.Fatal(err)
	}
	defer s.stop()
	if st := s.status(); len(st.Bound) != 0 || st.Pending["127.0.0.1"] == "" {
		t.Fatalf("busy address must be pending: %+v", st)
	}
	busy.Close()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if st := s.status(); len(st.Bound) == 1 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("address was not bound after it became free")
}

func TestStaticServerRequiresBuildAndValidHosts(t *testing.T) {
	var s staticServer
	if err := s.start(t.TempDir(), freeLoopbackPort(t), []string{"127.0.0.1"}); err == nil {
		t.Fatal("missing dist/index.html accepted")
	}
	if err := s.start("relative", 5173, []string{"127.0.0.1"}); err == nil {
		t.Fatal("relative dist accepted")
	}
	for _, bad := range []string{"0.0.0.0", "::", "example.com", "127.0.0.1,nope"} {
		if _, err := parseListenHosts(bad); err == nil {
			t.Fatalf("listen %q accepted", bad)
		}
	}
	hosts, err := parseListenHosts(" 127.0.0.1 , 100.102.19.106,127.0.0.1")
	if err != nil || strings.Join(hosts, ",") != "127.0.0.1,100.102.19.106" {
		t.Fatalf("hosts: %v %v", hosts, err)
	}
	if hosts, _ := parseListenHosts(""); strings.Join(hosts, ",") != "127.0.0.1" {
		t.Fatal("default must be loopback only")
	}
}
