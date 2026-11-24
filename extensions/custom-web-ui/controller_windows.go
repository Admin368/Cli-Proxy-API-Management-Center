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
	HistoryFile string `yaml:"history_file"`
	Workspace   string `yaml:"workspace"`
	Bun         string `yaml:"bun_binary"`
	Port        int    `yaml:"port"`
}
type serverStatus struct {
	Running  bool   `json:"running"`
	Managed  bool   `json:"managed"`
	Starting bool   `json:"starting"`
	URL      string `json:"url"`
	Error    string `json:"error,omitempty"`
	PID      uint32 `json:"pid,omitempty"`
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
}

var server controller

func (c *controller) configure(cfg config) error {
	if cfg.Port == 0 {
		cfg.Port = 5173
	}
	if cfg.Port < 1024 || cfg.Port > 65535 {
		return errors.New("port must be between 1024 and 65535")
	}
	c.Lock()
	defer c.Unlock()
	if c.job != 0 && c.cfg != cfg {
		return errors.New("stop the managed server before changing its configuration")
	}
	c.cfg = cfg
	return nil
}
func urlFor(cfg config) string { return "http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/" }
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
	running := probe(urlFor(cfg))
	return serverStatus{Running: running, Managed: owned, Starting: owned && !running, URL: urlFor(cfg), PID: pid, Error: last}
}
func (c *controller) start() error {
	c.Lock()
	defer c.Unlock()
	if c.job != 0 {
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
	if c.job != 0 {
		windows.TerminateJobObject(c.job, 0)
		windows.CloseHandle(c.job)
		c.job = 0
		c.process = 0
		c.pid = 0
		c.generation++
	}
}
