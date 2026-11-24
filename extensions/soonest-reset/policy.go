package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

type observation struct {
	Observed time.Time `json:"observed"`
	Reset    time.Time `json:"reset"`
	Provider string    `json:"provider"`
}
type pending struct {
	ID    string
	Until time.Time
}
type counters struct {
	FallbackReasons    map[string]uint64 `json:"fallback_reasons"`
	LastFallbackReason string            `json:"last_fallback_reason,omitempty"`
	LoadedAt           time.Time         `json:"loaded_at"`
	LastPick           time.Time         `json:"last_pick"`
	Selections         uint64            `json:"soonest_reset_selections"`
	Delegations        uint64            `json:"core_delegations"`
	Observations       uint64            `json:"live_observations"`
}
type policy struct {
	Stats      counters
	NextStatus time.Time
	sync.Mutex
	Records   map[string]observation
	Pending   map[string]pending
	StateFile string
	Cursor    uint64
}

var router = policy{Records: map[string]observation{}, Pending: map[string]pending{}}
var hostCall = callHost

func digest(id string) string { sum := sha256.Sum256([]byte(id)); return hex.EncodeToString(sum[:]) }
func valid(o observation, now time.Time) bool {
	return !o.Observed.IsZero() && !o.Observed.After(now.Add(time.Minute)) && now.Sub(o.Observed) <= 24*time.Hour && o.Reset.After(now) && o.Reset.Before(now.Add(8*24*time.Hour))
}
func resetObservation(provider string, headers http.Header, at time.Time) (observation, bool) {
	h := map[string]string{}
	for k, values := range headers {
		if len(values) > 0 {
			h[strings.ToLower(k)] = strings.TrimSpace(values[len(values)-1])
		}
	}
	parse := func(raw string) time.Time {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return time.Unix(n, 0).UTC()
		}
		t, _ := time.Parse(time.RFC3339, raw)
		return t
	}
	var reset time.Time
	switch provider {
	case "claude":
		reset = parse(h["anthropic-ratelimit-unified-7d-reset"])
	case "codex":
		// Only the long quota window is comparable across credentials. Short rate limits
		// and additional/model-specific limits remain the host's eligibility concern.
		for _, window := range []string{"primary", "secondary"} {
			prefix := "x-codex-" + window + "-"
			minutes, _ := strconv.Atoi(h[prefix+"window-minutes"])
			if minutes < 10000 || minutes > 10080 {
				continue
			}
			candidate := parse(h[prefix+"reset-at"])
			if candidate.IsZero() {
				if seconds, err := strconv.Atoi(h[prefix+"reset-after-seconds"]); err == nil && seconds > 0 && seconds <= 604800 {
					candidate = at.Add(time.Duration(seconds) * time.Second)
				}
			}
			if reset.IsZero() || candidate.Before(reset) {
				reset = candidate
			}
		}
	}
	o := observation{Observed: at, Reset: reset, Provider: provider}
	return o, valid(o, at)
}
func (p *policy) observe(key string, o observation) {
	p.Lock()
	defer p.Unlock()
	if key == "" || !valid(o, time.Now()) || o.Observed.Before(p.Records[key].Observed) {
		return
	}
	if _, exists := p.Records[key]; !exists && len(p.Records) >= 10000 {
		for k, v := range p.Records {
			if !valid(v, time.Now()) {
				delete(p.Records, k)
			}
		}
		if len(p.Records) >= 10000 {
			return
		}
	}
	p.Records[key] = o
	p.Stats.Observations++
	p.saveLocked()
}
func (p *policy) saveLocked() {
	if p.StateFile == "" {
		return
	}
	now := time.Now()
	for k, v := range p.Records {
		if !valid(v, now) {
			delete(p.Records, k)
		}
	}
	if len(p.Records) > 10000 {
		return
	}
	raw, err := json.Marshal(p.Records)
	if err != nil {
		return
	}
	if os.MkdirAll(filepath.Dir(p.StateFile), 0700) != nil {
		return
	}
	tmp := p.StateFile + ".tmp"
	if os.WriteFile(tmp, raw, 0600) == nil {
		_ = os.Rename(tmp, p.StateFile)
	}
}
func (p *policy) choose(req pluginapi.SchedulerPickRequest, now time.Time, lookup func(string, any, any) error) (decision pluginapi.SchedulerPickResponse) {
	reason := "unknown"
	defer func() {
		p.Lock()
		defer p.Unlock()
		p.Stats.LastPick = now
		if decision.Handled {
			p.Stats.Selections++
		} else {
			p.Stats.Delegations++
			if p.Stats.FallbackReasons == nil {
				p.Stats.FallbackReasons = map[string]uint64{}
			}
			p.Stats.FallbackReasons[reason]++
			p.Stats.LastFallbackReason = reason
		}
		p.statusLocked()
	}()
	fallback := pluginapi.SchedulerPickResponse{}
	routingProvider := req.Provider
	// v8 mixed routing leaves Provider empty even when every candidate is Claude.
	// Compare resets only within one provider; preserve the host's mixed affinity namespace.
	if routingProvider == "" && len(req.Candidates) > 0 {
		routingProvider = req.Candidates[0].Provider
		for _, candidate := range req.Candidates {
			if candidate.Provider != routingProvider {
				reason = "mixed_provider_pool"
				return fallback
			}
		}
	}
	if routingProvider != "claude" && routingProvider != "codex" {
		reason = "unsupported_provider"
		return fallback
	}
	meta := req.Options.Metadata
	session, _ := meta["canonical_session_id"].(string)
	// Let the host resolve hierarchy, explicit pins, and all existing bindings.
	if session == "" {
		reason = "missing_session"
		return fallback
	}
	if meta["parent_session_id"] != nil || meta["pinned_auth_id"] != nil {
		reason = "parent_or_explicit_pin"
		return fallback
	}
	provider, model := req.Provider, req.Model
	if provider == "" {
		provider = "mixed"
	}
	if v, ok := meta["session_affinity_provider"].(string); ok && v != "" {
		provider = v
	}
	if v, ok := meta["session_affinity_model"].(string); ok && v != "" {
		model = v
	}
	var binding pluginapi.HostAffinityLookupResponse
	if lookup(pluginabi.MethodHostAffinityLookup, pluginapi.HostAffinityLookupRequest{Provider: provider, Model: model, SessionID: session}, &binding) != nil {
		reason = "affinity_lookup_error"
		return fallback
	}
	if binding.Status != "unbound" {
		reason = "affinity_unsupported"
		if binding.Status == "bound" {
			reason = "existing_affinity"
		}
		if binding.Status == "ambiguous" {
			reason = "ambiguous_affinity"
		}
		return fallback
	}
	p.Lock()
	defer p.Unlock()
	// Unknown credentials get normal round-robin opportunities to acquire readings.
	// Do not starve them by permanently preferring already-observed credentials.
	type ranked struct {
		ID    string
		Reset time.Time
	}
	rankedCandidates := []ranked{}
	for _, c := range req.Candidates {
		o := p.Records[digest("id:"+c.ID)]
		if !valid(o, now) || o.Provider != c.Provider {
			reason = "missing_or_stale_reset"
			return fallback
		}
		rankedCandidates = append(rankedCandidates, ranked{c.ID, o.Reset})
	}
	if len(rankedCandidates) == 0 {
		reason = "no_candidates"
		return fallback
	}
	sort.Slice(rankedCandidates, func(i, j int) bool {
		if rankedCandidates[i].Reset.Equal(rankedCandidates[j].Reset) {
			return rankedCandidates[i].ID < rankedCandidates[j].ID
		}
		return rankedCandidates[i].Reset.Before(rankedCandidates[j].Reset)
	})
	sessionKey := digest(provider + "\x00" + model + "\x00" + session)
	if pin, ok := p.Pending[sessionKey]; ok && pin.Until.After(now) {
		for _, c := range rankedCandidates {
			if c.ID == pin.ID {
				return pluginapi.SchedulerPickResponse{Handled: true, AuthID: pin.ID}
			}
		}
	}
	tied := 1
	for tied < len(rankedCandidates) && rankedCandidates[tied].Reset.Equal(rankedCandidates[0].Reset) {
		tied++
	}
	selected := rankedCandidates[p.Cursor%uint64(tied)].ID
	p.Cursor++
	for k, v := range p.Pending {
		if !v.Until.After(now) {
			delete(p.Pending, k)
		}
	}
	if len(p.Pending) < 10000 {
		p.Pending[sessionKey] = pending{selected, now.Add(time.Minute)}
	}
	return pluginapi.SchedulerPickResponse{Handled: true, AuthID: selected}
}
func handleMethod(method string, request []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		var req lifecycleRequest
		if err := json.Unmarshal(request, &req); err != nil {
			return nil, err
		}
		var cfg struct {
			StateFile string `yaml:"state_file"`
		}
		if err := yaml.Unmarshal(req.ConfigYAML, &cfg); err != nil {
			return nil, err
		}
		router.Lock()
		if router.StateFile != cfg.StateFile {
			router.Records = map[string]observation{}
			router.Pending = map[string]pending{}
			router.Stats = counters{}
		}
		router.StateFile = cfg.StateFile
		router.Stats.LoadedAt = time.Now()
		router.NextStatus = time.Time{}
		router.statusLocked()
		if raw, err := os.ReadFile(cfg.StateFile); err == nil && len(raw) <= 4*1024*1024 {
			var saved map[string]observation
			if json.Unmarshal(raw, &saved) == nil {
				for k, v := range saved {
					if len(router.Records) < 10000 && len(k) == 64 && valid(v, time.Now()) && !v.Observed.Before(router.Records[k].Observed) {
						router.Records[k] = v
					}
				}
			}
		}
		router.Unlock()
		return okEnvelope(map[string]any{"schema_version": pluginabi.SchemaVersion, "metadata": pluginapi.Metadata{Name: "soonest-reset", Version: "0.1.2", Author: "Local", GitHubRepository: "https://github.com/Admin368/Cli-Proxy-API-Management-Center", ConfigFields: []pluginapi.ConfigField{{Name: "state_file", Type: pluginapi.ConfigFieldTypeString, Description: "Local quota observation file; stores hashed credential IDs and timestamps only."}}}, "capabilities": map[string]bool{"scheduler": true, "usage_plugin": true}})
	case pluginabi.MethodUsageHandle:
		var record pluginapi.UsageRecord
		if err := json.Unmarshal(request, &record); err != nil {
			return nil, err
		}
		if record.Generate && record.AuthID != "" {
			if o, ok := resetObservation(record.Provider, record.ResponseHeaders, record.RequestedAt); ok {
				router.observe(digest("id:"+record.AuthID), o)
			}
		}
		return okEnvelope(map[string]any{})
	case pluginabi.MethodSchedulerPick:
		var req pluginapi.SchedulerPickRequest
		if err := json.Unmarshal(request, &req); err != nil {
			return nil, err
		}
		hydrateIndexes()
		return okEnvelope(router.choose(req, time.Now(), hostCall))
	default:
		return errorEnvelope("unknown_method", "unsupported method"), nil
	}
}

var mappingMu sync.Mutex
var nextMapping time.Time

func hydrateIndexes() {
	mappingMu.Lock()
	defer mappingMu.Unlock()
	if time.Now().Before(nextMapping) {
		return
	}
	nextMapping = time.Now().Add(time.Minute)
	var result struct {
		Files []struct {
			ID    string `json:"id"`
			Index string `json:"auth_index"`
		} `json:"files"`
	}
	if hostCall(pluginabi.MethodHostAuthList, map[string]any{}, &result) != nil {
		return
	}
	router.Lock()
	defer router.Unlock()
	for _, f := range result.Files {
		if f.ID == "" || f.Index == "" {
			continue
		}
		from := router.Records[digest("index:"+f.Index)]
		to := digest("id:" + f.ID)
		if valid(from, time.Now()) && from.Observed.After(router.Records[to].Observed) {
			router.Records[to] = from
		}
	}
}

func (p *policy) statusLocked() {
	if p.StateFile == "" || time.Now().Before(p.NextStatus) {
		return
	}
	p.NextStatus = time.Now().Add(5 * time.Second)
	raw, _ := json.Marshal(p.Stats)
	if os.MkdirAll(filepath.Dir(p.StateFile), 0700) == nil {
		_ = os.WriteFile(p.StateFile+".status.json", raw, 0600)
	}
}
