package main

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func createUsageFixture(t *testing.T, dir string, rows int) string {
	t.Helper()
	path := filepath.Join(dir, "usage.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`PRAGMA journal_mode=WAL;
CREATE TABLE usage_events (id INTEGER PRIMARY KEY, timestamp TEXT, timestamp_ms INTEGER, model TEXT, provider TEXT, source TEXT,
 api_key_hash TEXT, failed INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER,
 cache_creation_tokens INTEGER, total_tokens INTEGER, latency_ms INTEGER, ttft_ms INTEGER, canceled INTEGER, reasoning_effort TEXT,
 response_model TEXT, generate INTEGER, auth_index TEXT, request_id TEXT, failure_body TEXT, client_ip TEXT, api_key_display TEXT)`); err != nil {
		t.Fatal(err)
	}
	insert := `INSERT INTO usage_events (id, timestamp, timestamp_ms, model, provider, source, api_key_hash, failed, input_tokens, output_tokens,
 reasoning_tokens, cache_read_tokens, cache_creation_tokens, total_tokens, latency_ms, ttft_ms, canceled, reasoning_effort, response_model,
 generate, auth_index, request_id, failure_body, client_ip, api_key_display) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
	hash := "ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789"
	fixtures := [][]any{
		{1, "2026-11-28T10:00:00Z", 1, "claude-opus", "claude", "claude-1.json", hash, 0, 10, 20, 0, 5, 1, 36, 900, 120, 0, "high", "claude-opus-4", 1, "auth-a", "req-1", "secret body", "10.0.0.1", "sk-***"},
		{2, "2026-11-28T10:01:00Z", 2, "gpt-5", "codex", "../etc/passwd", "not-a-hash", 1, 3, 4, 0, 0, 0, 7, 100, nil, 1, nil, nil, 0, "", "bad id with spaces", nil, nil, nil},
	}
	for _, row := range fixtures {
		if _, err := db.Exec(insert, row...); err != nil {
			t.Fatal(err)
		}
	}
	for id := 3; id <= rows; id++ {
		if _, err := db.Exec(insert, id, "2026-11-28T11:00:00Z", id, "m", "p", "s.json", hash, 0, 1, 1, 0, 0, 0, 2, 1, nil, 0, nil, nil, 1, nil, nil, nil, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestUsageRecordsProjectionMatchesHelper(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "folder with spaces")
	os.MkdirAll(dir, 0o700)
	path := createUsageFixture(t, dir, 2)
	page, err := readUsageRecords(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Cursor != "2" || page.HasMore {
		t.Fatalf("unexpected page: %+v", page)
	}
	first, second := page.Items[0], page.Items[1]
	if first["id"] != sha256Hex("desktop-row:1") || first["account_id"] != sha256Hex("auth:auth-a") {
		t.Fatal("row or account fingerprint differs from the Python helper")
	}
	if first["log_request_id"] != "req-1" || first["resolved_model"] != "claude-opus-4" || first["failed"] != false || first["canceled"] != false {
		t.Fatalf("first row: %+v", first)
	}
	if first["source"] != "claude-1.json" || first["total_tokens"] != int64(36) || first["ttft_ms"] != int64(120) {
		t.Fatalf("first row values: %+v", first)
	}
	for _, private := range []string{"failure_body", "client_ip", "api_key_display", "auth_index", "request_id", "timestamp_ms", "generate", "response_model"} {
		if _, ok := first[private]; ok {
			t.Fatalf("%s must not be exposed", private)
		}
	}
	if second["source"] != "" || second["api_key_hash"] != "" || second["failed"] != true || second["canceled"] != true {
		t.Fatalf("second row sanitisation: %+v", second)
	}
	if _, ok := second["log_request_id"]; ok {
		t.Fatal("unsafe request id exposed")
	}
	if _, ok := second["account_id"]; ok {
		t.Fatal("empty auth index fingerprinted")
	}
	if second["resolved_model"] != "gpt-5" || second["total_tokens"] != nil || second["input_tokens"] != nil {
		t.Fatalf("non-generate row must blank token counts: %+v", second)
	}
}

func TestUsageRecordsPagingAndWindow(t *testing.T) {
	path := createUsageFixture(t, t.TempDir(), 1203)
	page, err := readUsageRecords(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 500 || !page.HasMore || page.Cursor != "500" {
		t.Fatalf("first page: %d items, cursor %s, more %v", len(page.Items), page.Cursor, page.HasMore)
	}
	page, err = readUsageRecords(path, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 203 || page.HasMore || page.Cursor != "1203" {
		t.Fatalf("last page: %d items, cursor %s, more %v", len(page.Items), page.Cursor, page.HasMore)
	}
	page, err = readUsageRecords(path, 1203)
	if err != nil || len(page.Items) != 0 || page.Cursor != "1203" {
		t.Fatalf("empty page: %+v %v", page, err)
	}
}

func TestUsageRecordsIsReadOnlyAndRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	if _, err := readUsageRecords(filepath.Join(dir, "missing.db"), 0); err == nil {
		t.Fatal("missing database must fail")
	}
	if _, err := os.Stat(filepath.Join(dir, "missing.db")); !os.IsNotExist(err) {
		t.Fatal("read-only open created a database file")
	}
	other := filepath.Join(dir, "other.db")
	db, _ := sql.Open("sqlite", other)
	db.Exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY, model TEXT)`)
	db.Close()
	if _, err := readUsageRecords(other, 0); err != errUsageSchema {
		t.Fatalf("unsupported schema: %v", err)
	}
	for _, bad := range []string{"-1", "abc", "12345678901234567", "1 OR 1=1"} {
		if _, err := parseUsageCursor(url.Values{"after": {bad}}); err == nil {
			t.Fatalf("cursor %q accepted", bad)
		}
	}
	if after, err := parseUsageCursor(url.Values{}); err != nil || after != 0 {
		t.Fatal("missing cursor must mean 0")
	}
	if err := sharedUsage.configure("relative/usage.db"); err == nil {
		t.Fatal("relative database path accepted")
	}
}

func TestUsageRecordsRouteRequiresConfiguration(t *testing.T) {
	sharedUsage.configure("")
	defer sharedUsage.configure("")
	raw, _ := usageRecordsResponse(url.Values{})
	if !containsStatus(raw, 404) {
		t.Fatal("unconfigured database must return 404")
	}
	path := createUsageFixture(t, t.TempDir(), 3)
	sharedUsage.configure(path)
	raw, _ = usageRecordsResponse(url.Values{"after": {"1"}})
	if !containsStatus(raw, 200) {
		t.Fatal("configured database must return 200")
	}
	raw, _ = usageRecordsResponse(url.Values{"after": {"x"}})
	if !containsStatus(raw, 400) {
		t.Fatal("invalid cursor must return 400")
	}
}

func containsStatus(raw []byte, status int) bool {
	return len(raw) > 0 && contains(string(raw), `"StatusCode":`+strconv.Itoa(status))
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
