package main

import (
	"encoding/json"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func unbound(_ string, _ any, out any) error {
	out.(*pluginapi.HostAffinityLookupResponse).Status = "unbound"
	return nil
}
func request() pluginapi.SchedulerPickRequest {
	return pluginapi.SchedulerPickRequest{Provider: "claude", Model: "opus", Options: pluginapi.SchedulerOptions{Metadata: map[string]any{"canonical_session_id": "session"}}, Candidates: []pluginapi.SchedulerAuthCandidate{{ID: "a", Provider: "claude"}, {ID: "b", Provider: "claude"}}}
}
func setup() (*policy, time.Time) {
	now := time.Now()
	p := &policy{Records: map[string]observation{}, Pending: map[string]pending{}}
	p.Records[digest("id:a")] = observation{now, now.Add(10 * time.Hour), "claude"}
	p.Records[digest("id:b")] = observation{now, now.Add(time.Hour), "claude"}
	return p, now
}
func TestSoonestResetAndHostEligibility(t *testing.T) {
	p, now := setup()
	r := request()
	if got := p.choose(r, now, unbound); got.AuthID != "b" || !got.Handled {
		t.Fatal(got)
	}
	r.Candidates = r.Candidates[:1]
	if got := p.choose(r, now, unbound); got.AuthID != "a" {
		t.Fatal("removed/unavailable candidate selected", got)
	}
}
func TestAffinityAndFailoverDelegate(t *testing.T) {
	p, now := setup()
	for _, status := range []string{"bound", "ambiguous", "unsupported"} {
		lookup := func(_ string, _ any, out any) error {
			out.(*pluginapi.HostAffinityLookupResponse).Status = status
			return nil
		}
		if p.choose(request(), now, lookup).Handled {
			t.Fatal(status)
		}
	}
	if p.choose(request(), now, func(string, any, any) error { return errors.New("offline") }).Handled {
		t.Fatal("lookup failure must delegate")
	}
}
func TestUnknownStaleResetAndHierarchyDelegate(t *testing.T) {
	for _, mode := range []string{"unknown", "stale", "reset", "parent", "pin", "missing-session"} {
		p, now := setup()
		r := request()
		switch mode {
		case "unknown":
			delete(p.Records, digest("id:a"))
		case "stale":
			v := p.Records[digest("id:a")]
			v.Observed = now.Add(-25 * time.Hour)
			p.Records[digest("id:a")] = v
		case "reset":
			v := p.Records[digest("id:a")]
			v.Reset = now.Add(-time.Second)
			p.Records[digest("id:a")] = v
		case "parent":
			r.Options.Metadata["parent_session_id"] = "parent"
		case "pin":
			r.Options.Metadata["pinned_auth_id"] = "a"
		case "missing-session":
			delete(r.Options.Metadata, "canonical_session_id")
		}
		if p.choose(r, now, unbound).Handled {
			t.Fatal(mode)
		}
	}
}
func TestResetHeaders(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	cases := []struct {
		p     string
		h     http.Header
		ok    bool
		reset time.Time
	}{{"claude", http.Header{"anthropic-ratelimit-unified-7d-reset": {now.Add(time.Hour).Format(time.RFC3339)}}, true, now.Add(time.Hour)}, {"codex", http.Header{"X-Codex-Secondary-Window-Minutes": {"10080"}, "X-Codex-Secondary-Reset-After-Seconds": {"3600"}}, true, now.Add(time.Hour)}, {"codex", http.Header{"X-Codex-Primary-Window-Minutes": {"300"}, "X-Codex-Primary-Reset-After-Seconds": {"3600"}}, false, time.Time{}}, {"claude", http.Header{"Anthropic-Ratelimit-Unified-7d-Reset": {"garbage"}}, false, time.Time{}}}
	for _, c := range cases {
		o, ok := resetObservation(c.p, c.h, now)
		if ok != c.ok || ok && !o.Reset.Equal(c.reset) {
			t.Fatalf("%s: %#v %v", c.p, o, ok)
		}
	}
}
func TestNoSecretsPersistenceAndOldResponses(t *testing.T) {
	p, now := setup()
	p.StateFile = filepath.Join(t.TempDir(), "state.json")
	key := digest("id:private-credential-name")
	p.observe(key, observation{now, now.Add(time.Hour), "claude"})
	p.observe(key, observation{now.Add(-time.Hour), now.Add(2 * time.Hour), "claude"})
	raw, err := os.ReadFile(p.StateFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private-credential") {
		t.Fatal("credential leaked")
	}
	var saved map[string]observation
	if json.Unmarshal(raw, &saved) != nil || !saved[key].Reset.Equal(now.Add(time.Hour)) {
		t.Fatal("older observation replaced current")
	}
}
func TestPendingSessionStability(t *testing.T) {
	p, now := setup()
	a := p.Records[digest("id:a")]
	a.Reset = p.Records[digest("id:b")].Reset
	p.Records[digest("id:a")] = a
	r := request()
	first := p.choose(r, now, unbound)
	for range 20 {
		if p.choose(r, now, unbound).AuthID != first.AuthID {
			t.Fatal("pending session moved")
		}
	}
	r.Options.Metadata["canonical_session_id"] = "other"
	if p.choose(r, now, unbound).AuthID == first.AuthID {
		t.Fatal("ties should rotate across sessions")
	}
}
func TestNonGenerationAndStateScopeIsolation(t *testing.T) {
	router.Lock()
	router.Records = map[string]observation{}
	router.Pending = map[string]pending{}
	router.StateFile = ""
	router.Unlock()
	now := time.Now()
	record := pluginapi.UsageRecord{AuthID: "count-only", Provider: "claude", RequestedAt: now, Generate: false, ResponseHeaders: http.Header{"Anthropic-Ratelimit-Unified-7d-Reset": {now.Add(time.Hour).Format(time.RFC3339)}}}
	raw, _ := json.Marshal(record)
	if _, err := handleMethod("usage.handle", raw); err != nil {
		t.Fatal(err)
	}
	if len(router.Records) != 0 {
		t.Fatal("count-tokens request changed generation quota observation")
	}
	router.Records[digest("id:old")] = observation{now, now.Add(time.Hour), "claude"}
	config, _ := json.Marshal(lifecycleRequest{ConfigYAML: []byte("state_file: " + filepath.ToSlash(filepath.Join(t.TempDir(), "other.json")))})
	if _, err := handleMethod("plugin.reconfigure", config); err != nil {
		t.Fatal(err)
	}
	if len(router.Records) != 0 {
		t.Fatal("old state leaked across state-file change")
	}
}
func TestFallbackDiagnostics(t *testing.T) {
	p, now := setup()
	r := request()
	delete(r.Options.Metadata, "canonical_session_id")
	p.choose(r, now, unbound)
	if p.Stats.FallbackReasons["missing_session"] != 1 {
		t.Fatal(p.Stats)
	}
	p.choose(request(), now, func(_ string, _ any, out any) error {
		out.(*pluginapi.HostAffinityLookupResponse).Status = "bound"
		return nil
	})
	if p.Stats.FallbackReasons["existing_affinity"] != 1 {
		t.Fatal(p.Stats)
	}
	delete(p.Records, digest("id:a"))
	p.choose(request(), now, unbound)
	if p.Stats.FallbackReasons["missing_or_stale_reset"] != 1 {
		t.Fatal(p.Stats)
	}
}
func TestV8MixedRouteWithSingleProvider(t *testing.T) {
	p, now := setup()
	r := request()
	r.Provider = ""
	r.Providers = []string{"claude"}
	got := p.choose(r, now, func(_ string, payload any, out any) error {
		if payload.(pluginapi.HostAffinityLookupRequest).Provider != "mixed" {
			t.Fatal("lost mixed affinity namespace")
		}
		out.(*pluginapi.HostAffinityLookupResponse).Status = "unbound"
		return nil
	})
	if !got.Handled || got.AuthID != "b" {
		t.Fatal(got, p.Stats)
	}
	r.Candidates[0].Provider = "codex"
	if p.choose(r, now, unbound).Handled {
		t.Fatal("cross-provider reset ranking is unsupported")
	}
}
