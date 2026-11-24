package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type quotaPoint struct {
	ID        string  `json:"id"`
	Provider  string  `json:"provider"`
	Window    string  `json:"window"`
	At        float64 `json:"at"`
	Remaining float64 `json:"remaining"`
	Reset     float64 `json:"reset"`
	Period    float64 `json:"period"`
}
type forecastData struct {
	Observations   []quotaPoint   `json:"observations"`
	Preferences    map[string]any `json:"preferences"`
	LastActivityAt float64        `json:"lastActivityAt"`
}
type forecastStore struct {
	sync.Mutex
	path string
	data forecastData
}

var sharedForecast forecastStore

func validPoint(p quotaPoint, now float64) bool {
	id, err := hex.DecodeString(p.ID)
	return err == nil && len(id) == 32 && (p.Provider == "claude" || p.Provider == "codex" || p.Provider == "antigravity" || p.Provider == "kimi" || p.Provider == "xai" || p.Provider == "devin" || p.Provider == "meta" || p.Provider == "plugin") && (p.Window == "session" || p.Window == "weekly") && p.At > now-14*86400000 && p.At <= now+60000 && p.Reset > p.At && p.Remaining >= 0 && p.Remaining <= 100 && p.Period > 0 && p.Period <= 336 && !math.IsNaN(p.Remaining) && !math.IsInf(p.Remaining, 0)
}
func validPreference(key string, value any) bool {
	switch key {
	case "window":
		return value == "session" || value == "weekly"
	case "rateHours":
		return value == float64(1) || value == float64(3) || value == float64(6)
	case "horizon":
		return value == float64(5) || value == float64(10) || value == float64(24) || value == float64(48) || value == float64(72) || value == float64(168)
	case "scale":
		return value == "capacity" || value == "adaptive" || value == "normalized"
	case "factor":
		return value == 0.5 || value == float64(1) || value == float64(2)
	case "showAccounts":
		_, ok := value.(bool)
		return ok
	case "tab":
		switch value {
		case "all", "claude", "codex", "antigravity", "kimi", "xai", "devin", "meta", "plugin":
			return true
		}
	case "sortMode":
		switch value {
		case "default", "soonest", "latest", "availability":
			return true
		}
	}
	return false
}
func (s *forecastStore) mergeLocked(points []quotaPoint) {
	now := float64(time.Now().UnixMilli())
	byKey := map[string]quotaPoint{}
	for _, p := range append(s.data.Observations, points...) {
		if !validPoint(p, now) {
			continue
		}
		key := p.ID + ":" + p.Provider + ":" + p.Window + ":" + strconv.FormatInt(int64(p.At)/300000, 10)
		if old, ok := byKey[key]; !ok || p.At >= old.At {
			byKey[key] = p
		}
	}
	s.data.Observations = make([]quotaPoint, 0, len(byKey))
	for _, p := range byKey {
		s.data.Observations = append(s.data.Observations, p)
	}
	sort.Slice(s.data.Observations, func(i, j int) bool { return s.data.Observations[i].At < s.data.Observations[j].At })
	if len(s.data.Observations) > 5000 {
		s.data.Observations = s.data.Observations[len(s.data.Observations)-5000:]
	}
}
func (s *forecastStore) configure(path string) error {
	s.Lock()
	defer s.Unlock()
	if path == s.path {
		return nil
	}
	s.path = path
	s.data = forecastData{Observations: []quotaPoint{}, Preferences: map[string]any{}}
	if raw, err := os.ReadFile(path); err == nil && len(raw) <= 4000000 {
		var loaded forecastData
		if json.Unmarshal(raw, &loaded) == nil {
			s.mergeLocked(loaded.Observations)
			for k, v := range loaded.Preferences {
				if validPreference(k, v) {
					s.data.Preferences[k] = v
				}
			}
			s.data.LastActivityAt = loaded.LastActivityAt
		}
	}
	return nil
}
func (s *forecastStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		return err
	}
	raw, err := json.Marshal(s.data)
	if err != nil {
		return err
	}
	if err = os.WriteFile(s.path+".tmp", raw, 0600); err != nil {
		return err
	}
	return os.Rename(s.path+".tmp", s.path)
}
func (s *forecastStore) snapshot() forecastData {
	s.Lock()
	defer s.Unlock()
	s.mergeLocked(nil)
	raw, _ := json.Marshal(s.data)
	var copy forecastData
	json.Unmarshal(raw, &copy)
	return copy
}
func (s *forecastStore) update(raw []byte) error {
	if len(raw) > 1500000 {
		return errors.New("forecast update too large")
	}
	var patch forecastData
	if err := json.Unmarshal(raw, &patch); err != nil {
		return err
	}
	if len(patch.Observations) > 5000 {
		return errors.New("too many observations")
	}
	for k, v := range patch.Preferences {
		if !validPreference(k, v) {
			return errors.New("invalid forecast preference")
		}
	}
	s.Lock()
	defer s.Unlock()
	s.mergeLocked(patch.Observations)
	if s.data.Preferences == nil {
		s.data.Preferences = map[string]any{}
	}
	for k, v := range patch.Preferences {
		s.data.Preferences[k] = v
	}
	return s.saveLocked()
}
func quotaPoints(record pluginapi.UsageRecord) []quotaPoint {
	if !record.Generate || record.AuthIndex == "" || record.RequestedAt.IsZero() {
		return nil
	}
	sum := sha256.Sum256([]byte("auth:" + record.AuthIndex))
	id := hex.EncodeToString(sum[:])
	h := map[string]string{}
	for k, v := range record.ResponseHeaders {
		if len(v) > 0 {
			h[strings.ToLower(k)] = v[len(v)-1]
		}
	}
	number := func(key string) (float64, bool) {
		v, e := strconv.ParseFloat(h[key], 64)
		return v, e == nil && !math.IsNaN(v) && !math.IsInf(v, 0)
	}
	at := float64(record.RequestedAt.UnixMilli())
	points := []quotaPoint{}
	add := func(window string, period, used, reset float64) {
		p := quotaPoint{id, record.Provider, window, at, math.Max(0, 100-used), reset, period}
		if validPoint(p, float64(time.Now().UnixMilli())) {
			points = append(points, p)
		}
	}
	if record.Provider == "claude" {
		for _, w := range []struct {
			name, kind string
			hours      float64
		}{{"5h", "session", 5}, {"7d", "weekly", 168}} {
			used, ok := number("anthropic-ratelimit-unified-" + w.name + "-utilization")
			reset, okReset := number("anthropic-ratelimit-unified-" + w.name + "-reset")
			if ok && okReset && used >= 0 && used <= 10 {
				add(w.kind, w.hours, used*100, reset*1000)
			}
		}
	}
	if record.Provider == "codex" {
		for _, w := range []string{"primary", "secondary"} {
			prefix := "x-codex-" + w + "-"
			minutes, okM := number(prefix + "window-minutes")
			used, okU := number(prefix + "used-percent")
			reset, okR := number(prefix + "reset-at")
			if !okR {
				if seconds, ok := number(prefix + "reset-after-seconds"); ok {
					reset = (at / 1000) + seconds
					okR = true
				}
			}
			kind := "weekly"
			if minutes <= 300 {
				kind = "session"
			}
			if okM && okU && okR && used >= 0 && used <= 100 && (minutes <= 300 || minutes >= 1440) {
				add(kind, minutes/60, used, reset*1000)
			}
		}
	}
	return points
}
func (s *forecastStore) observe(record pluginapi.UsageRecord) {
	points := quotaPoints(record)
	s.Lock()
	defer s.Unlock()
	if record.Generate && record.RequestedAt.UnixMilli() > int64(s.data.LastActivityAt) {
		s.data.LastActivityAt = float64(record.RequestedAt.UnixMilli())
	}
	s.mergeLocked(points)
	_ = s.saveLocked()
}
