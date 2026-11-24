//go:build windows

package integration

import (
	"context"
	"encoding/json"
	auth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	executor "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/executor"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

type buffer struct{ Ptr, Len uintptr }
type hostAPI struct {
	Version             uint32
	Context, Call, Free uintptr
}
type pluginAPI struct {
	Version              uint32
	Call, Free, Shutdown uintptr
}

func TestDLLWithCoreAffinityAndFailover(t *testing.T) {
	selector := auth.NewSessionAffinitySelectorWithConfig(auth.SessionAffinityConfig{TTL: time.Hour, RebindOn: "quota"})
	defer selector.Stop()
	kernel := syscall.NewLazyDLL("kernel32.dll")
	alloc := kernel.NewProc("LocalAlloc")
	free := kernel.NewProc("LocalFree")
	callback := syscall.NewCallback(func(ctx, method, request, length, response uintptr) uintptr {
		raw := unsafe.Slice((*byte)(unsafe.Pointer(method)), 128)
		end := 0
		for raw[end] != 0 {
			end++
		}
		var result any = map[string]any{"files": []any{}}
		if string(raw[:end]) == "host.affinity.lookup" {
			var req pluginapi.HostAffinityLookupRequest
			_ = json.Unmarshal(unsafe.Slice((*byte)(unsafe.Pointer(request)), length), &req)
			id, status := selector.LookupAffinity(req.Provider, req.Model, req.SessionID)
			result = pluginapi.HostAffinityLookupResponse{Status: status, AuthIndex: id}
		}
		data, _ := json.Marshal(map[string]any{"ok": true, "result": result})
		ptr, _, _ := alloc.Call(0, uintptr(len(data)))
		copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(data)), data)
		*(*buffer)(unsafe.Pointer(response)) = buffer{ptr, uintptr(len(data))}
		return 0
	})
	release := syscall.NewCallback(func(ptr, length uintptr) uintptr { free.Call(ptr); return 0 })
	host := hostAPI{Version: 1, Call: callback, Free: release}
	var plugin pluginAPI
	path, _ := filepath.Abs("../bin/soonest-reset.dll")
	dll, err := syscall.LoadDLL(path)
	if err != nil {
		t.Fatal(err)
	}
	init, err := dll.FindProc("cliproxy_plugin_init")
	if err != nil {
		t.Fatal(err)
	}
	code, _, _ := init.Call(uintptr(unsafe.Pointer(&host)), uintptr(unsafe.Pointer(&plugin)))
	if code != 0 {
		t.Fatal("init", code)
	}
	call := func(method string, payload any, out any) {
		t.Helper()
		raw, _ := json.Marshal(payload)
		name, _ := syscall.BytePtrFromString(method)
		var response buffer
		code, _, _ := syscall.SyscallN(plugin.Call, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&raw[0])), uintptr(len(raw)), uintptr(unsafe.Pointer(&response)))
		runtime.KeepAlive(raw)
		runtime.KeepAlive(name)
		var env struct {
			OK     bool            `json:"ok"`
			Result json.RawMessage `json:"result"`
		}
		err := json.Unmarshal(unsafe.Slice((*byte)(unsafe.Pointer(response.Ptr)), response.Len), &env)
		syscall.SyscallN(plugin.Free, response.Ptr, response.Len)
		if code != 0 || err != nil || !env.OK {
			t.Fatalf("%s failed: %v", method, err)
		}
		if out != nil {
			if err = json.Unmarshal(env.Result, out); err != nil {
				t.Fatal(err)
			}
		}
	}
	call("plugin.register", map[string]any{}, nil)
	now := time.Now()
	observe := func(id string, hours int) {
		call("usage.handle", pluginapi.UsageRecord{AuthID: id, Generate: true, Provider: "claude", RequestedAt: now, ResponseHeaders: map[string][]string{"Anthropic-Ratelimit-Unified-7d-Reset": {now.Add(time.Duration(hours) * time.Hour).Format(time.RFC3339)}}}, nil)
	}
	observe("a", 8)
	observe("b", 2)
	opts := executor.Options{Headers: map[string][]string{"X-Claude-Code-Session-Id": {"sess-integrated"}}, Metadata: map[string]any{"canonical_session_id": "sess-integrated", "session_affinity_provider": "mixed"}}
	accounts := []*auth.Auth{{ID: "a", Provider: "claude"}, {ID: "b", Provider: "claude"}}
	pick := func(available []*auth.Auth) string {
		t.Helper()
		req := pluginapi.SchedulerPickRequest{Provider: "", Providers: []string{"claude"}, Model: "opus", Options: pluginapi.SchedulerOptions{Headers: opts.Headers, Metadata: opts.Metadata}}
		for _, a := range available {
			req.Candidates = append(req.Candidates, pluginapi.SchedulerAuthCandidate{ID: a.ID, Provider: a.Provider})
		}
		var decision pluginapi.SchedulerPickResponse
		call("scheduler.pick", req, &decision)
		if decision.Handled {
			return decision.AuthID
		}
		selected, err := selector.Pick(context.Background(), "mixed", "opus", opts, available)
		if err != nil {
			t.Fatal(err)
		}
		return selected.ID
	}
	if got := pick(accounts); got != "b" {
		t.Fatal("cold session", got)
	}
	selector.OnResult(auth.Result{AuthID: "b", Provider: "claude", Model: "opus", Success: true, Options: opts})
	observe("a", 1)
	if got := pick(accounts); got != "b" {
		t.Fatal("successful affinity moved", got)
	}
	// Transient failures must preserve the original session under quota-only rebind.
	selector.OnResult(auth.Result{AuthID: "b", Provider: "claude", Model: "opus", Error: &auth.Error{HTTPStatus: 503}, Options: opts})
	if got := pick(accounts); got != "b" {
		t.Fatal("transient failure lost binding", got)
	}
	selector.OnResult(auth.Result{AuthID: "b", Provider: "claude", Model: "opus", Error: &auth.Error{HTTPStatus: 429, Code: "rate_limit_exceeded"}, Options: opts})
	if got := pick(accounts[:1]); got != "a" {
		t.Fatal("quota failover", got)
	}
	selector.OnResult(auth.Result{AuthID: "a", Provider: "claude", Model: "opus", Success: true, Options: opts})
	if got := pick(accounts); got != "a" {
		t.Fatal("failover binding not retained", got)
	}
	runtime.KeepAlive(host)
}
