package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// staticServer serves the built dashboard (dist/) from inside the plugin, so
// no Bun or Python process is needed. It belongs to the core: it starts with
// the plugin and stops on Stop, plugin shutdown or core exit. Addresses that
// cannot be bound yet (for example a Tailscale address before Tailscale is
// up) are retried in the background until they succeed or the server stops.

var staticRetryInterval = 10 * time.Second

type staticServer struct {
	mu      sync.Mutex
	dist    string
	port    int
	hosts   []string
	servers map[string]*http.Server
	pending map[string]string
	stopped chan struct{}
	active  bool
}

type staticStatus struct {
	Active  bool
	Bound   []string
	Pending map[string]string
}

func parseListenHosts(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return []string{"127.0.0.1"}, nil
	}
	seen := map[string]bool{}
	hosts := []string{}
	for _, part := range strings.Split(value, ",") {
		host := strings.TrimSpace(part)
		if host == "" {
			continue
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return nil, errors.New("listen must be a comma-separated list of IP addresses, e.g. 127.0.0.1,100.64.0.1")
		}
		if ip.IsUnspecified() {
			return nil, errors.New("listen does not accept 0.0.0.0 or ::; name each address the dashboard should use")
		}
		host = ip.String()
		if !seen[host] {
			seen[host] = true
			hosts = append(hosts, host)
		}
	}
	if len(hosts) == 0 {
		return []string{"127.0.0.1"}, nil
	}
	return hosts, nil
}

func hostURL(host string, port int) string {
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port)) + "/"
}

func (s *staticServer) start(dist string, port int, hosts []string) error {
	if !filepath.IsAbs(dist) {
		return errors.New("configure an absolute dist_dir (or workspace) first")
	}
	if info, err := os.Stat(filepath.Join(dist, "index.html")); err != nil || info.IsDir() {
		return errors.New("dashboard build not found: run \"bun run build\" in the workspace so dist/index.html exists")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active {
		return nil
	}
	s.dist, s.port, s.hosts = dist, port, append([]string(nil), hosts...)
	s.servers = map[string]*http.Server{}
	s.pending = map[string]string{}
	s.stopped = make(chan struct{})
	s.active = true
	for _, host := range hosts {
		s.bindLocked(host)
	}
	if len(s.pending) > 0 {
		go s.retry(s.stopped)
	}
	return nil
}

func (s *staticServer) bindLocked(host string) {
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(s.port)))
	if err != nil {
		s.pending[host] = err.Error()
		return
	}
	delete(s.pending, host)
	srv := &http.Server{Handler: dashboardHandler(s.dist), ReadHeaderTimeout: 10 * time.Second}
	s.servers[host] = srv
	go srv.Serve(listener)
}

func (s *staticServer) retry(stopped chan struct{}) {
	ticker := time.NewTicker(staticRetryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stopped:
			return
		case <-ticker.C:
			s.mu.Lock()
			if !s.active || s.stopped != stopped {
				s.mu.Unlock()
				return
			}
			for host := range s.pending {
				s.bindLocked(host)
			}
			done := len(s.pending) == 0
			s.mu.Unlock()
			if done {
				return
			}
		}
	}
}

func (s *staticServer) stop() bool {
	s.mu.Lock()
	if !s.active {
		s.mu.Unlock()
		return false
	}
	close(s.stopped)
	servers := s.servers
	s.servers, s.pending, s.active = nil, nil, false
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, srv := range servers {
		if srv.Shutdown(ctx) != nil {
			srv.Close()
		}
	}
	return true
}

func (s *staticServer) status() staticStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := staticStatus{Active: s.active, Pending: map[string]string{}}
	for _, host := range s.hosts {
		if _, ok := s.servers[host]; ok && s.active {
			st.Bound = append(st.Bound, host)
		}
	}
	for host, reason := range s.pending {
		st.Pending[host] = reason
	}
	return st
}

func pendingSummary(pending map[string]string) string {
	if len(pending) == 0 {
		return ""
	}
	hosts := make([]string, 0, len(pending))
	for host := range pending {
		hosts = append(hosts, host)
	}
	sort.Strings(hosts)
	parts := make([]string, len(hosts))
	for i, host := range hosts {
		parts[i] = host + ": " + pending[host]
	}
	return "Not yet listening on " + strings.Join(parts, "; ") + ". Retrying every 10 seconds."
}

// dashboardHandler serves only regular files below dist. Paths without a file
// extension fall back to index.html (the dashboard uses hash routes); hidden
// files and anything outside dist are never served.
func dashboardHandler(dist string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		clean := path.Clean("/" + r.URL.Path)
		for _, segment := range strings.Split(clean, "/") {
			if strings.HasPrefix(segment, ".") {
				http.NotFound(w, r)
				return
			}
		}
		target := filepath.Join(dist, filepath.FromSlash(clean))
		rel, err := filepath.Rel(dist, target)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			http.NotFound(w, r)
			return
		}
		info, err := os.Stat(target)
		if err != nil || info.IsDir() {
			if path.Ext(clean) != "" {
				http.NotFound(w, r)
				return
			}
			target = filepath.Join(dist, "index.html")
			if info, err = os.Stat(target); err != nil || info.IsDir() {
				http.NotFound(w, r)
				return
			}
		}
		if filepath.Base(target) == "index.html" {
			h.Set("Cache-Control", "no-cache")
		} else if strings.HasPrefix(clean, "/assets/") {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		file, err := os.Open(target)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		http.ServeContent(w, r, info.Name(), info.ModTime(), file)
	})
}
