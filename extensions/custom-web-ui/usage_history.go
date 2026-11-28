package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

// Read-only bridge to the desktop app's usage database. It mirrors
// scripts/usage-helper/server.py so records imported through either source
// keep identical ids and fields, and it is served behind the core's
// management authentication instead of a separate loopback token.

const (
	usagePageSize   = 500
	usageWindowRows = 10000
)

var (
	usageRequiredFields = []string{"id", "timestamp", "timestamp_ms", "model", "provider", "source", "api_key_hash",
		"failed", "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens",
		"cache_creation_tokens", "total_tokens", "latency_ms"}
	usageOptionalFields = []string{"ttft_ms", "canceled", "reasoning_effort", "response_model", "generate", "auth_index", "request_id"}
	usageTokenFields    = []string{"input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens"}

	safeSource     = regexp.MustCompile(`(?i)^[A-Za-z0-9_.@+() -]+\.json$`)
	safeKeyHash    = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)
	safeRequestID  = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	safeCursor     = regexp.MustCompile(`^[0-9]{1,16}$`)
	errUsageSchema = errors.New("unsupported desktop history schema")
)

type usagePage struct {
	Items   []map[string]any `json:"items"`
	Cursor  string           `json:"cursor"`
	HasMore bool             `json:"hasMore"`
}

type usageHistory struct {
	sync.Mutex
	path string
}

var sharedUsage usageHistory

func validateUsagePath(path string) error {
	path = strings.TrimSpace(path)
	if path != "" && !filepath.IsAbs(path) {
		return errors.New("usage_database must be an absolute path")
	}
	return nil
}

func (u *usageHistory) configure(path string) error {
	if err := validateUsagePath(path); err != nil {
		return err
	}
	path = strings.TrimSpace(path)
	u.Lock()
	u.path = path
	u.Unlock()
	return nil
}

func (u *usageHistory) configured() string {
	u.Lock()
	defer u.Unlock()
	return u.path
}

func parseUsageCursor(query url.Values) (int64, error) {
	after := query.Get("after")
	if after == "" {
		after = "0"
	}
	if !safeCursor.MatchString(after) {
		return 0, errors.New("invalid cursor")
	}
	return strconv.ParseInt(after, 10, 64)
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// readUsageRecords opens the database read-only for each call; SQLite's normal
// locking also reads recent records still held in the live WAL.
func readUsageRecords(path string, after int64) (usagePage, error) {
	db, err := sql.Open("sqlite", readOnlyDSN(path))
	if err != nil {
		return usagePage{}, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	columns := map[string]bool{}
	info, err := db.Query(`PRAGMA table_info(usage_events)`)
	if err != nil {
		return usagePage{}, err
	}
	for info.Next() {
		var cid int
		var name, kind string
		var notNull, pk int
		var def any
		if err := info.Scan(&cid, &name, &kind, &notNull, &def, &pk); err != nil {
			info.Close()
			return usagePage{}, err
		}
		columns[name] = true
	}
	info.Close()
	if err := info.Err(); err != nil {
		return usagePage{}, err
	}
	selected := []string{}
	for _, field := range usageRequiredFields {
		if !columns[field] {
			return usagePage{}, errUsageSchema
		}
		selected = append(selected, field)
	}
	for _, field := range usageOptionalFields {
		if columns[field] {
			selected = append(selected, field)
		}
	}
	quoted := make([]string, len(selected))
	for i, field := range selected {
		quoted[i] = `"` + field + `"`
	}
	// Only approved fields are projected: never failure bodies, headers, raw keys or client IPs.
	query := fmt.Sprintf(`SELECT %s FROM (SELECT * FROM usage_events ORDER BY id DESC LIMIT %d) WHERE id > ? ORDER BY id LIMIT %d`,
		strings.Join(quoted, ","), usageWindowRows, usagePageSize+1)
	rows, err := db.Query(query, after)
	if err != nil {
		return usagePage{}, err
	}
	defer rows.Close()

	page := usagePage{Items: []map[string]any{}, Cursor: strconv.FormatInt(after, 10)}
	count := 0
	for rows.Next() {
		values := make([]any, len(selected))
		pointers := make([]any, len(selected))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return usagePage{}, err
		}
		count++
		if count > usagePageSize {
			page.HasMore = true
			break
		}
		row := map[string]any{}
		for i, field := range selected {
			row[field] = normalizeSQLValue(values[i])
		}
		rowID, ok := row["id"].(int64)
		if !ok {
			return usagePage{}, errUsageSchema
		}
		page.Cursor = strconv.FormatInt(rowID, 10)
		page.Items = append(page.Items, projectUsageRow(row, rowID))
	}
	if err := rows.Err(); err != nil {
		return usagePage{}, err
	}
	return page, nil
}

// readOnlyDSN builds an SQLite URI (mode=ro, so the file is never created or
// written) with each path segment percent-encoded, e.g. for folders with spaces.
func readOnlyDSN(path string) string {
	segments := strings.Split(filepath.ToSlash(path), "/")
	for i, segment := range segments {
		segments[i] = strings.ReplaceAll(url.PathEscape(segment), "%3A", ":")
	}
	location := strings.Join(segments, "/")
	if !strings.HasPrefix(location, "/") {
		location = "/" + location
	}
	return "file:" + location + "?mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(2000)"
}

func normalizeSQLValue(value any) any {
	switch v := value.(type) {
	case []byte:
		return string(v)
	case int:
		return int64(v)
	case int32:
		return int64(v)
	default:
		return v
	}
}

func stringValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func truthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case int64:
		return v != 0
	case float64:
		return v != 0
	case bool:
		return v
	case string:
		return v != ""
	default:
		return true
	}
}

func projectUsageRow(row map[string]any, rowID int64) map[string]any {
	item := map[string]any{}
	for key, value := range row {
		item[key] = value
	}
	delete(item, "id")
	delete(item, "timestamp_ms")

	requestID, hasRequestID := item["request_id"]
	delete(item, "request_id")
	if hasRequestID {
		if id := strings.TrimSpace(stringValue(requestID)); safeRequestID.MatchString(id) {
			item["log_request_id"] = id
		}
	}
	item["id"] = sha256Hex("desktop-row:" + strconv.FormatInt(rowID, 10))

	authIndex, hasAuth := item["auth_index"]
	delete(item, "auth_index")
	if hasAuth {
		if index := strings.TrimSpace(stringValue(authIndex)); index != "" {
			item["account_id"] = sha256Hex("auth:" + index)
		}
	}
	if source, ok := item["source"].(string); ok && safeSource.MatchString(source) {
		item["source"] = source
	} else {
		item["source"] = ""
	}
	if hash, ok := item["api_key_hash"].(string); ok && safeKeyHash.MatchString(hash) {
		item["api_key_hash"] = hash
	} else {
		item["api_key_hash"] = ""
	}
	item["failed"] = truthy(item["failed"])
	item["canceled"] = truthy(item["canceled"])

	model := item["model"]
	responseModel := item["response_model"]
	delete(item, "response_model")
	if truthy(responseModel) {
		item["resolved_model"] = responseModel
	} else {
		item["resolved_model"] = model
	}

	generate := true
	if value, ok := item["generate"]; ok {
		generate = truthy(value)
	}
	delete(item, "generate")
	if !generate {
		for _, field := range usageTokenFields {
			item[field] = nil
		}
	}
	return item
}
