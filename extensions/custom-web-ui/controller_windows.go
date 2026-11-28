//go:build windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

type config struct {
	HistoryFile   string `yaml:"history_file"`
	Workspace     string `yaml:"workspace"`
	Bun           string `yaml:"bun_binary"`
	Port          int    `yaml:"port"`
	Mode          string `yaml:"mode"`           // "dev" (default): bun run dev; "static": serve dist/ from the plugin
	DistDir       string `yaml:"dist_dir"`       // static mode; defaults to <workspace>\dist
	Listen        string `yaml:"listen"`         // static mode; comma-separated IPs, default 127.0.0.1
	AutoStart     bool   `yaml:"auto_start"`     // start the dashboard server whenever the core loads the plugin
	UsageDatabase string `yaml:"usage_database"` // desktop usage.db served read-only to the dashboard
}
type serverStatus struct {
	Running  bool     `json:"running"`
	Managed  bool     `json:"managed"`
	Starting bool     `json:"starting"`
	URL      string   `json:"url"`
	URLs     []string `json:"urls,omitempty"`
	Mode     string   `json:"mode"`
	Error    string   `json:"error,omitempty"`
	PID      uint32   `json:"pid,omitempty"`
}
type controller struct {
	sync.Mutex
	cfg        config
	job        windows.Handle
	process    windows.Handle
	pid        uint32
	generation uint64
	lastError  string
	command    func(config) []string
	static     staticServer
}

var server controller

func (cfg config) static() bool { return cfg.Mode == "static" }
func (cfg config) distDir() string {
	if cfg.DistDir != "" {
		return cfg.DistDir
	}
	if cfg.Workspace == "" {
		return ""
	}
	return filepath.Join(cfg.Workspace, "dist")
}

func (c *controller) configure(cfg config) error {
	if cfg.Port == 0 {
		cfg.Port = 5173
	}
	if cfg.Port < 1024 || cfg.Port > 65535 {
		return errors.New("port must be between 1024 and 65535")
	}
	switch cfg.Mode {
	case "":
		cfg.Mode = "dev"
	case "dev", "static":
	default:
		return errors.New(`mode must be "dev" or "static"`)
	}
	if _, err := parseListenHosts(cfg.Listen); err != nil {
		return err
	}
	c.Lock()
	defer c.Unlock()
	if c.job != 0 && c.cfg != cfg {
		return errors.New("stop the managed server before changing its configuration")
	}
	if c.static.status().Active && servingChanged(c.cfg, cfg) {
		// The built-in server restarts cheaply; apply new serving settings right away.
		// Switching to dev mode only stops it: Bun starts on Start or auto_start.
		c.static.stop()
		c.cfg = cfg
		if cfg.static() {
			if err := c.startLocked(); err != nil {
				c.lastError = err.Error()
			}
		}
		return nil
	}
	c.cfg = cfg
	return nil
}
// servingChanged reports whether a change affects what or where the static server serves.
func servingChanged(a, b config) bool {
	return a.Mode != b.Mode || a.distDir() != b.distDir() || a.Listen != b.Listen || a.Port != b.Port
}
func urlFor(cfg config) string { return "http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/" }

func (c *controller) autoStartEnabled() bool {
	c.Lock()
	defer c.Unlock()
	return c.cfg.AutoStart
}

// autoStart starts the configured server when auto_start is set. Failures are
// reported through status instead of failing plugin registration.
func (c *controller) autoStart() {
	c.Lock()
	enabled := c.cfg.AutoStart
	c.Unlock()
	if !enabled {
		return
	}
	if err := c.start(); err != nil {
		c.Lock()
		c.lastError = "Auto-start: " + err.Error()
		c.Unlock()
	}
}
func probe(url string) bool {
	client := http.Client{Timeout: 600 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == 200
}
func (c *controller) status() serverStatus {
	c.Lock()
	cfg := c.cfg
	owned := c.job != 0
	pid := c.pid
	last := c.lastError
	c.Unlock()
	mode := cfg.Mode
	if mode == "" {
		mode = "dev"
	}
	if st := c.static.status(); st.Active {
		urls := make([]string, len(st.Bound))
		for i, host := range st.Bound {
			urls[i] = hostURL(host, cfg.Port)
		}
		primary := urlFor(cfg)
		if len(urls) > 0 {
			primary = urls[0]
		}
		message := pendingSummary(st.Pending)
		if message == "" {
			message = last
		}
		return serverStatus{Running: len(urls) > 0, Managed: true, Starting: len(urls) == 0, URL: primary, URLs: urls, Mode: mode, Error: message}
	}
	running := probe(urlFor(cfg))
	return serverStatus{Running: running, Managed: owned, Starting: owned && !running, URL: urlFor(cfg), Mode: mode, PID: pid, Error: last}
}
func (c *controller) start() error {
	c.Lock()
	defer c.Unlock()
	return c.startLocked()
}
func (c *controller) startLocked() error {
	if c.job != 0 || c.static.status().Active {
		return nil
	}
	if c.cfg.static() {
		// Busy addresses are reported per address and retried, so no loopback probe here:
		// listen may not include 127.0.0.1 at all.
		hosts, err := parseListenHosts(c.cfg.Listen)
		if err != nil {
			return err
		}
		if err := c.static.start(c.cfg.distDir(), c.cfg.Port, hosts); err != nil {
			return err
		}
		c.lastError = ""
		return nil
	}
	if probe(urlFor(c.cfg)) {
		return errors.New("a server is already running outside this plugin; it will not be stopped or replaced")
	}
	if !filepath.IsAbs(c.cfg.Workspace) || !filepath.IsAbs(c.cfg.Bun) {
		return errors.New("configure absolute workspace and bun_binary paths first")
	}
	if _, err := os.Stat(filepath.Join(c.cfg.Workspace, "package.json")); err != nil {
		return errors.New("workspace package.json was not found")
	}
	if info, err := os.Stat(c.cfg.Bun); err != nil || info.IsDir() {
		return errors.New("Bun executable was not found")
	}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return err
	}
	args := []string{c.cfg.Bun, "run", "dev", "--host", "127.0.0.1", "--port", strconv.Itoa(c.cfg.Port), "--strictPort"}
	if c.command != nil {
		args = c.command(c.cfg)
	}
	escaped := make([]string, len(args))
	for i, arg := range args {
		escaped[i] = syscall.EscapeArg(arg)
	}
	command, err := windows.UTF16PtrFromString(strings.Join(escaped, " "))
	if err != nil {
		windows.CloseHandle(job)
		return err
	}
	directory, err := windows.UTF16PtrFromString(c.cfg.Workspace)
	if err != nil {
		windows.CloseHandle(job)
		return err
	}
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Flags: windows.STARTF_USESHOWWINDOW, ShowWindow: windows.SW_HIDE}
	var child windows.ProcessInformation
	// Assign the suspended parent before it can spawn children: Stop terminates only this job tree.
	if err = windows.CreateProcess(nil, command, nil, nil, false, windows.CREATE_NO_WINDOW|windows.CREATE_SUSPENDED, nil, directory, &startup, &child); err != nil {
		windows.CloseHandle(job)
		return err
	}
	defer windows.CloseHandle(child.Thread)
	if err = windows.AssignProcessToJobObject(job, child.Process); err != nil {
		windows.TerminateProcess(child.Process, 1)
		windows.CloseHandle(child.Process)
		windows.CloseHandle(job)
		return err
	}
	if _, err = windows.ResumeThread(child.Thread); err != nil {
		windows.TerminateJobObject(job, 1)
		windows.CloseHandle(child.Process)
		windows.CloseHandle(job)
		return err
	}
	c.job = job
	c.process = child.Process
	c.pid = child.ProcessId
	c.generation++
	c.lastError = ""
	generation := c.generation
	go func() {
		windows.WaitForSingleObject(child.Process, windows.INFINITE)
		var code uint32
		windows.GetExitCodeProcess(child.Process, &code)
		c.Lock()
		defer c.Unlock()
		windows.CloseHandle(child.Process)
		if c.generation == generation {
			windows.TerminateJobObject(job, 1)
			windows.CloseHandle(job)
			c.job = 0
			c.process = 0
			c.pid = 0
			if code != 0 {
				c.lastError = fmt.Sprintf("Development server exited with code %d. Check that dependencies are installed in the workspace.", code)
			}
		}
	}()
	return nil
}
func (c *controller) stop() error {
	c.Lock()
	defer c.Unlock()
	if c.static.stop() {
		c.lastError = ""
		return nil
	}
	if c.job == 0 {
		return errors.New("no server owned by this plugin is running")
	}
	if err := windows.TerminateJobObject(c.job, 0); err != nil {
		return err
	}
	windows.CloseHandle(c.job)
	c.job = 0
	c.process = 0
	c.pid = 0
	c.generation++
	c.lastError = ""
	return nil
}
func (c *controller) shutdown() {
	c.Lock()
	defer c.Unlock()
	c.static.stop()
	if c.job != 0 {
		windows.TerminateJobObject(c.job, 0)
		windows.CloseHandle(c.job)
		c.job = 0
		c.process = 0
		c.pid = 0
		c.generation++
	}
}
