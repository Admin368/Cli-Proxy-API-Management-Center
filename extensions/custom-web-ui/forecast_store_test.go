package main

import (
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestForecastPersistsAndMergesPreferencePatches(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forecast.json")
	s := forecastStore{}
	s.configure(path)
	if err := s.update([]byte(`{"preferences":{"window":"session","sortMode":"availability","rateHours":6}}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.update([]byte(`{"preferences":{"horizon":24}}`)); err != nil {
		t.Fatal(err)
	}
	restored := forecastStore{}
	restored.configure(path)
	want := map[string]any{"window": "session", "sortMode": "availability", "rateHours": float64(6), "horizon": float64(24)}
	if !reflect.DeepEqual(restored.snapshot().Preferences, want) {
		t.Fatal(restored.snapshot().Preferences)
	}
	for _, raw := range []string{`{"preferences":{"window":[]}}`, `{"preferences":{"managementKey":"secret"}}`, `{"preferences":{"rateHours":99}}`} {
		if s.update([]byte(raw)) == nil {
			t.Fatal("invalid preference accepted")
		}
	}
}
func TestBackgroundQuotaCaptureKeepsNoCredentialsOrBodies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "forecast.json")
	s := forecastStore{}
	s.configure(path)
	now := time.Now()
	record := pluginapi.UsageRecord{Provider: "claude", AuthIndex: "private-index", AuthID: "private-account", APIKey: "private-key", Generate: true, RequestedAt: now, Failure: pluginapi.UsageFailure{Body: "private-body"}, ResponseHeaders: http.Header{"Anthropic-Ratelimit-Unified-5h-Utilization": {"0.4"}, "Anthropic-Ratelimit-Unified-5h-Reset": {strconv.FormatInt(now.Add(time.Hour).Unix(), 10)}, "Authorization": {"private-token"}}}
	s.observe(record)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "private-") {
		t.Fatal("sensitive data persisted")
	}
	copy := forecastStore{}
	copy.configure(path)
	data := copy.snapshot()
	if len(data.Observations) != 1 || data.Observations[0].Remaining != 60 || data.Observations[0].Window != "session" || len(data.Observations[0].ID) != 64 {
		t.Fatal(data)
	}
	record.Generate = false
	s.observe(record)
	if len(s.snapshot().Observations) != 1 {
		t.Fatal("count-only request created quota history")
	}
	var content map[string]any
	if json.Unmarshal(raw, &content) != nil {
		t.Fatal("invalid file")
	}
}

func TestForecastScaleAndNewHorizons(t *testing.T) {
	s := forecastStore{}
	s.configure(filepath.Join(t.TempDir(), "forecast.json"))
	for _, raw := range []string{`{"preferences":{"horizon":5,"scale":"adaptive"}}`, `{"preferences":{"horizon":10,"scale":"normalized"}}`, `{"preferences":{"horizon":48,"scale":"adaptive"}}`, `{"preferences":{"horizon":72,"scale":"normalized"}}`} {
		if err := s.update([]byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
	if s.update([]byte(`{"preferences":{"scale":"invalid"}}`)) == nil {
		t.Fatal("invalid scale accepted")
	}
}
