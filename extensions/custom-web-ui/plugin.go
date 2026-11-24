package main

import (
	_ "embed"
	"encoding/json"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
	"net/http"
	"strings"
)

//go:embed panel.html
var panel []byte

const apiPath = "/plugins/custom-web-ui/"

func handleMethod(method string, raw []byte) ([]byte, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		var request lifecycleRequest
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, err
		}
		var cfg config
		if err := yaml.Unmarshal(request.ConfigYAML, &cfg); err != nil {
			return nil, err
		}
		if err := server.configure(cfg); err != nil {
			return nil, err
		}
		if err := sharedForecast.configure(cfg.HistoryFile); err != nil {
			return nil, err
		}
		return okEnvelope(map[string]any{"schema_version": pluginabi.SchemaVersion, "metadata": pluginapi.Metadata{Name: "Custom Web UI", Version: "0.2.2", Author: "Local", GitHubRepository: "https://github.com/Admin368/Cli-Proxy-API-Management-Center", ConfigFields: []pluginapi.ConfigField{
			{Name: "workspace", Type: pluginapi.ConfigFieldTypeString, Description: "Absolute path to the custom management UI checkout."},
			{Name: "bun_binary", Type: pluginapi.ConfigFieldTypeString, Description: "Absolute path to bun.exe."},
			{Name: "history_file", Type: pluginapi.ConfigFieldTypeString, Description: "Durable, credential-free quota observations and UI preferences for this proxy."},
			{Name: "port", Type: pluginapi.ConfigFieldTypeInteger, Default: 5173, Description: "Loopback-only development server port."},
		}}, "capabilities": map[string]bool{"management_api": true, "usage_plugin": true}})
	case pluginabi.MethodUsageHandle:
		var record pluginapi.UsageRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return nil, err
		}
		sharedForecast.observe(record)
		return okEnvelope(map[string]any{})
	case pluginabi.MethodManagementRegister:
		return okEnvelope(pluginapi.ManagementRegistrationResponse{Resources: []pluginapi.ResourceRoute{{Path: "/panel", Menu: "Custom Web UI", Description: "Start, stop and open your custom management UI."}}, Routes: []pluginapi.ManagementRoute{
			{Method: "GET", Path: apiPath + "forecast"}, {Method: "PUT", Path: apiPath + "forecast"}, {Method: "GET", Path: apiPath + "status"}, {Method: "POST", Path: apiPath + "start"}, {Method: "POST", Path: apiPath + "stop"},
		}})
	case pluginabi.MethodManagementHandle:
		var req pluginapi.ManagementRequest
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, err
		}
		if req.Method == "GET" && strings.HasSuffix(req.Path, "/panel") {
			return okEnvelope(pluginapi.ManagementResponse{StatusCode: 200, Headers: http.Header{"Content-Type": {"text/html; charset=utf-8"}, "Cache-Control": {"no-store"}, "Referrer-Policy": {"no-referrer"}}, Body: panel})
		}
		if strings.HasSuffix(req.Path, apiPath+"forecast") {
			if req.Method == "GET" {
				return jsonResponse(200, sharedForecast.snapshot())
			}
			if req.Method == "PUT" {
				if err := sharedForecast.update(req.Body); err != nil {
					return jsonResponse(400, map[string]string{"error": err.Error()})
				}
				return jsonResponse(200, sharedForecast.snapshot())
			}
			return jsonResponse(405, map[string]string{"error": "method not allowed"})
		}
		status := http.StatusOK
		var actionErr error
		switch {
		case req.Method == "GET" && strings.HasSuffix(req.Path, apiPath+"status"):
		case req.Method == "POST" && strings.HasSuffix(req.Path, apiPath+"start"):
			actionErr = server.start()
		case req.Method == "POST" && strings.HasSuffix(req.Path, apiPath+"stop"):
			actionErr = server.stop()
		default:
			return jsonResponse(405, map[string]string{"error": "method not allowed"})
		}
		state := server.status()
		if actionErr != nil {
			status = 409
			state.Error = actionErr.Error()
		}
		return jsonResponse(status, state)
	default:
		return errorEnvelope("unknown_method", "unsupported method"), nil
	}
}
func jsonResponse(status int, value any) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return okEnvelope(pluginapi.ManagementResponse{StatusCode: status, Headers: http.Header{"Content-Type": {"application/json"}, "Cache-Control": {"no-store"}}, Body: body})
}
