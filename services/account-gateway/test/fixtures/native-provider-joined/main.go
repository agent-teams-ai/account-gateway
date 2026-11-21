// Test-only composition built inside the actual native module. All four
// protected providers use actual PG/custody/lifecycle/transport boundaries.
// The only upstream is this disposable TLS fixture; no live accounts run.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	_ "github.com/Wei-Shaw/sub2api/ent/runtime"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/gatewaytransport"
	"github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/Wei-Shaw/sub2api/internal/pkg/xai"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

type configuration struct{ DSN, Consumer, Control, Callback, Execution, Cleanup string }
type counts struct {
	Dispatches      int64 `json:"dispatches"`
	Exchanges       int64 `json:"exchanges"`
	Refreshes       int64 `json:"refreshes"`
	QuotaGets       int64 `json:"quotaGets"`
	FunctionCalls   int64 `json:"functionCalls"`
	CustomCalls     int64 `json:"customCalls"`
	FunctionOutputs int64 `json:"functionOutputs"`
	CustomOutputs   int64 `json:"customOutputs"`
	SchemaRequests  int64 `json:"schemaRequests"`
	SignatureChecks int64 `json:"signatureChecks"`
}
type counters struct {
	dispatches, exchanges, refreshes, quotaGets, functionCalls, customCalls, functionOutputs, customOutputs atomic.Int64
	schemaRequests, signatureChecks                                                                         atomic.Int64
	toolMu                                                                                                  sync.Mutex
	pendingTools                                                                                            *toolContinuation
}

type toolContinuation struct {
	custom, reasoning bool
	calls             map[string]officialTool
}

type officialTool struct {
	Name       string
	Parameters json.RawMessage
	Arguments  string
	Signature  string
}

func officialArguments(tool officialTool) (string, []string, error) {
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
	}
	if json.Unmarshal(tool.Parameters, &schema) != nil {
		return "", nil, deny
	}
	args := map[string]any{}
	switch {
	case tool.Name == "joined_lookup":
	case strings.HasSuffix(tool.Name, "exec_command") && schema.Properties["cmd"] != nil:
		args = map[string]any{"cmd": "pwd", "yield_time_ms": 1000, "max_output_tokens": 1000}
	case strings.HasSuffix(tool.Name, "shell_command") && schema.Properties["command"] != nil:
		args = map[string]any{"command": "pwd", "timeout_ms": 1000}
	case tool.Name == "shell" && schema.Properties["command"] != nil:
		args = map[string]any{"command": []string{"sh", "-lc", "pwd"}}
	case strings.HasSuffix(tool.Name, "apply_patch") && schema.Properties["input"] != nil:
		args = map[string]any{"input": "*** Begin Patch\n*** End Patch\n"}
	default:
		return "", nil, deny
	}
	for key := range args {
		if schema.Properties[key] == nil {
			delete(args, key)
		}
	}
	for _, key := range schema.Required {
		if _, exists := args[key]; !exists {
			return "", nil, deny
		}
	}
	raw, err := json.Marshal(args)
	return string(raw), schema.Required, err
}

// This is the actual upstream protocol boundary: native must translate the
// public Responses conversation, preserve schema, and restore each tool proof.
func serveOfficial(w http.ResponseWriter, r *http.Request, provider string, c *counters, toolShapes map[string]any, toolShapeMu *sync.Mutex) error {
	model, path := service.GatewayAnthropicAPIModel, "/v1/messages"
	if provider == "gemini" {
		model, path = service.GatewayGeminiAPIModel, "/v1beta/openai/chat/completions"
		if r.Header.Get("Authorization") != "Bearer fixture-provider-key-gemini" || r.Header.Get("x-api-key") != "" {
			return deny
		}
	} else if r.Header.Get("Authorization") != "" || r.Header.Get("x-api-key") != "fixture-provider-key-anthropic" || r.Header.Get("anthropic-version") != "2023-06-01" {
		return deny
	}
	if r.Method != "POST" || r.URL.RequestURI() != path || r.Header.Get("Cookie") != "" || r.Header.Get("Idempotency-Key") != "" {
		return deny
	}
	var body map[string]json.RawMessage
	raw, err := io.ReadAll(io.LimitReader(r.Body, (4<<20)+1))
	if err != nil || len(raw) > 4<<20 || json.Unmarshal(raw, &body) != nil || string(body["model"]) != fmt.Sprintf("%q", model) || string(body["stream"]) != "true" {
		return deny
	}
	c.dispatches.Add(1)
	c.toolMu.Lock()
	defer c.toolMu.Unlock()
	var format struct {
		Type   string          `json:"type"`
		Schema json.RawMessage `json:"schema"`
	}
	if provider == "anthropic" {
		var output struct {
			Format json.RawMessage `json:"format"`
		}
		if json.Unmarshal(body["output_config"], &output) == nil {
			_ = json.Unmarshal(output.Format, &format)
		}
	} else {
		var output struct {
			Type       string          `json:"type"`
			JSONSchema json.RawMessage `json:"json_schema"`
		}
		if json.Unmarshal(body["response_format"], &output) == nil && output.Type == "json_schema" {
			_ = json.Unmarshal(output.JSONSchema, &format)
			format.Type = output.Type
		}
	}
	var schema struct {
		Properties map[string]json.RawMessage `json:"properties"`
	}
	if format.Type == "json_schema" && json.Unmarshal(format.Schema, &schema) == nil && schema.Properties["findings"] != nil && schema.Properties["revalidations"] != nil {
		c.schemaRequests.Add(1)
	} else if c.pendingTools == nil {
		return deny
	}
	var messages []struct {
		Role       string          `json:"role"`
		ToolCallID string          `json:"tool_call_id"`
		Content    json.RawMessage `json:"content"`
		ToolCalls  []struct {
			ID       string                           `json:"id"`
			Function struct{ Name, Arguments string } `json:"function"`
			Extra    struct {
				Google struct {
					Signature string `json:"thought_signature"`
				} `json:"google"`
			} `json:"extra_content"`
		} `json:"tool_calls"`
	}
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) == 0 {
		return deny
	}
	calls, outputs := map[string]officialTool{}, map[string]bool{}
	for _, message := range messages {
		if provider == "gemini" {
			for _, call := range message.ToolCalls {
				if message.Role != "assistant" || calls[call.ID].Name != "" {
					return deny
				}
				calls[call.ID] = officialTool{Name: call.Function.Name, Arguments: call.Function.Arguments, Signature: call.Extra.Google.Signature}
			}
			if message.Role == "tool" {
				if outputs[message.ToolCallID] || len(message.Content) == 0 || string(message.Content) == "null" {
					return deny
				}
				outputs[message.ToolCallID] = true
			}
			continue
		}
		var parts []struct {
			Type, ID, Name string
			ToolUseID      string          `json:"tool_use_id"`
			Input          json.RawMessage `json:"input"`
			Content        json.RawMessage `json:"content"`
		}
		if json.Unmarshal(message.Content, &parts) != nil {
			continue
		}
		for _, part := range parts {
			switch part.Type {
			case "tool_use":
				if message.Role != "assistant" || calls[part.ID].Name != "" {
					return deny
				}
				calls[part.ID] = officialTool{Name: part.Name, Arguments: string(part.Input)}
			case "tool_result":
				if message.Role != "user" || outputs[part.ToolUseID] || len(part.Content) == 0 || string(part.Content) == "null" {
					return deny
				}
				outputs[part.ToolUseID] = true
			}
		}
	}
	continuation := c.pendingTools != nil
	selected := map[string]officialTool{}
	if continuation {
		if len(calls) != len(c.pendingTools.calls) || len(outputs) != len(c.pendingTools.calls) {
			return deny
		}
		for id, expected := range c.pendingTools.calls {
			actual := calls[id]
			var a, b any
			if !outputs[id] || actual.Name != expected.Name || actual.Signature != expected.Signature || json.Unmarshal([]byte(actual.Arguments), &a) != nil || json.Unmarshal([]byte(expected.Arguments), &b) != nil || !reflect.DeepEqual(a, b) {
				return deny
			}
		}
		c.functionOutputs.Add(1)
		if c.pendingTools.custom {
			c.customOutputs.Add(1)
		}
		if provider == "gemini" {
			c.signatureChecks.Add(1)
		}
		c.pendingTools = nil
	} else {
		if len(calls) != 0 || len(outputs) != 0 {
			return deny
		}
		var tools []json.RawMessage
		if json.Unmarshal(body["tools"], &tools) != nil {
			return deny
		}
		shape := map[string]any{}
		for _, rawTool := range tools {
			var tool struct {
				Name        string          `json:"name"`
				InputSchema json.RawMessage `json:"input_schema"`
				Function    struct {
					Name       string          `json:"name"`
					Parameters json.RawMessage `json:"parameters"`
				} `json:"function"`
			}
			if json.Unmarshal(rawTool, &tool) != nil {
				return deny
			}
			candidate := officialTool{Name: tool.Name, Parameters: tool.InputSchema}
			if provider == "gemini" {
				candidate.Name, candidate.Parameters = tool.Function.Name, tool.Function.Parameters
			}
			args, required, e := officialArguments(candidate)
			if e != nil {
				continue
			}
			candidate.Arguments = args
			if strings.HasSuffix(candidate.Name, "apply_patch") {
				selected["joined-call-custom"] = candidate
				shape["customLoweredFunction"] = map[string]any{"name": candidate.Name, "type": "function", "inputProperty": "input"}
			} else if selected["joined-call-1"].Name == "" || strings.HasSuffix(candidate.Name, "exec_command") {
				selected["joined-call-1"] = candidate
				shape["name"], shape["type"], shape["requiredProperties"] = candidate.Name, "function", required
			}
		}
		if selected["joined-call-1"].Name == "" {
			return deny
		}
		if provider == "gemini" {
			first := selected["joined-call-1"]
			first.Signature = "joined-gemini-signature"
			selected["joined-call-1"] = first
		}
		_, custom := selected["joined-call-custom"]
		c.pendingTools = &toolContinuation{custom: custom, calls: selected}
		c.functionCalls.Add(1)
		if custom {
			c.customCalls.Add(1)
		}
		toolShapeMu.Lock()
		toolShapes[provider] = shape
		toolShapeMu.Unlock()
	}
	w.Header().Set("Content-Type", "text/event-stream")
	emit := func(kind string, body any) {
		raw, _ := json.Marshal(body)
		if provider == "anthropic" {
			_, _ = fmt.Fprintf(w, "event: %s\n", kind)
		}
		_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
	}
	text := `{"findings":[],"revalidations":[]}`
	if provider == "anthropic" {
		emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "joined-official", "type": "message", "role": "assistant", "model": model, "content": []any{}, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]int{"input_tokens": 7, "output_tokens": 0}}})
		if continuation {
			emit("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": text}})
			emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		} else {
			for index, id := range []string{"joined-call-1", "joined-call-custom"} {
				call, exists := selected[id]
				if !exists {
					continue
				}
				emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": call.Name, "input": map[string]any{}}})
				emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": call.Arguments}})
				emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
			}
		}
		reason := "tool_use"
		if continuation {
			reason = "end_turn"
		}
		emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": map[string]int{"output_tokens": 3}})
		emit("message_stop", map[string]string{"type": "message_stop"})
	} else {
		chunk := func(delta any, finish any) map[string]any {
			return map[string]any{"id": "joined-official", "object": "chat.completion.chunk", "created": 1, "model": model, "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
		}
		if continuation {
			emit("", chunk(map[string]any{"role": "assistant", "content": text}, nil))
		} else {
			for index, id := range []string{"joined-call-1", "joined-call-custom"} {
				call, exists := selected[id]
				if !exists {
					continue
				}
				emit("", chunk(map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": index, "id": id, "type": "function", "function": map[string]string{"name": call.Name, "arguments": call.Arguments}}}}, nil))
			}
			// Real Gemini may attach the first call's signature in a later delta.
			emit("", chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "extra_content": map[string]any{"google": map[string]string{"thought_signature": selected["joined-call-1"].Signature}}}}}, nil))
		}
		reason := "tool_calls"
		if continuation {
			reason = "stop"
		}
		last := chunk(map[string]any{}, reason)
		last["usage"] = map[string]int{"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}
		emit("", last)
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}
	return nil
}

// A provider may finish a tool turn only after consuming exactly the calls it
// actually issued. Tool declarations on the continuation cannot change this.
// The provider handler holds toolMu across validation and response emission.
func (c *counters) consumeToolContinuation(raw json.RawMessage) (bool, error) {
	var input []struct {
		Type    string          `json:"type"`
		CallID  string          `json:"call_id"`
		Output  string          `json:"output"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		var initialText string
		if c.pendingTools != nil || json.Unmarshal(raw, &initialText) != nil {
			return false, deny
		}
		return false, nil
	}
	outputs := map[string]string{}
	reasoning := false
	functionCall := false
	for _, item := range input {
		if item.Type == "function_call" && item.CallID == "joined-call-1" {
			functionCall = true
		}
		if item.Type == "reasoning" {
			var content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			reasoning = json.Unmarshal(item.Content, &content) == nil && len(content) == 1 && content[0].Type == "reasoning_text" && content[0].Text == "fixture thought"
		}
		// Custom calls are lowered to function calls on this provider wire.
		if item.Type == "custom_tool_call_output" {
			return false, deny
		}
		if item.Type != "function_call_output" {
			continue
		}
		if item.CallID != "joined-call-1" && item.CallID != "joined-call-custom" || item.Output == "" {
			return false, deny
		}
		if _, duplicate := outputs[item.CallID]; duplicate {
			return false, deny
		}
		outputs[item.CallID] = item.Output
	}
	if c.pendingTools == nil {
		if len(outputs) != 0 {
			return false, deny
		}
		return false, nil
	}
	if !functionCall || c.pendingTools.reasoning && !reasoning {
		return false, deny
	}
	custom := c.pendingTools.custom
	if outputs["joined-call-1"] == "" || custom && outputs["joined-call-custom"] == "" || !custom && outputs["joined-call-custom"] != "" {
		return false, deny
	}
	c.pendingTools = nil
	c.functionOutputs.Add(1)
	if custom {
		c.customOutputs.Add(1)
	}
	return true, nil
}

func (c *counters) snapshot() counts {
	return counts{c.dispatches.Load(), c.exchanges.Load(), c.refreshes.Load(), c.quotaGets.Load(), c.functionCalls.Load(), c.customCalls.Load(), c.functionOutputs.Load(), c.customOutputs.Load(), c.schemaRequests.Load(), c.signatureChecks.Load()}
}

var deny = errors.New("joined provider fixture refused")

type fixtureHTTP struct{ client *http.Client }

func (u fixtureHTTP) Do(r *http.Request, _ string, _ int64, concurrency int) (*http.Response, error) {
	if concurrency != 0 {
		return nil, deny
	}
	return u.client.Do(r)
}
func (u fixtureHTTP) DoWithTLS(r *http.Request, p string, id int64, c int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(r, p, id, c)
}

type oauthFixture struct {
	mu                      sync.Mutex
	key                     *ecdsa.PrivateKey
	state, nonce, challenge string
	access, refresh         string
}

func (o *oauthFixture) authorize(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme+"://"+u.Host+u.Path != xai.DefaultAuthorizeURL || u.Fragment != "" || u.User != nil {
		return "", deny
	}
	q := u.Query()
	if q.Get("client_id") != "joined-provider-client" || q.Get("redirect_uri") != xai.DefaultRedirectURI || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || len(q.Get("state")) != 64 || len(q.Get("nonce")) != 43 || len(q.Get("code_challenge")) != 43 {
		return "", deny
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.state, o.nonce, o.challenge = q.Get("state"), q.Get("nonce"), q.Get("code_challenge")
	return o.state, nil
}
func (o *oauthFixture) issue(r *http.Request) (map[string]any, error) {
	if r.Method != "POST" || r.Host != "auth.x.ai" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.ParseForm() != nil {
		return nil, deny
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if r.Form.Get("client_id") != "joined-provider-client" {
		return nil, deny
	}
	switch r.Form.Get("grant_type") {
	case "authorization_code":
		hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if o.state == "" || r.Form.Get("code") != "fixture-code" || r.Form.Get("redirect_uri") != xai.DefaultRedirectURI || base64.RawURLEncoding.EncodeToString(hash[:]) != o.challenge {
			return nil, deny
		}
		o.state = ""
	case "refresh_token":
		if r.Form.Get("refresh_token") != o.refresh {
			return nil, deny
		}
	default:
		return nil, deny
	}
	o.access = "joined-grok-access-" + uuid.NewString()
	o.refresh = "joined-grok-refresh-" + uuid.NewString()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{"iss": xai.OAuthIssuer, "sub": "joined-provider-subject", "aud": "joined-provider-client", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(), "nonce": o.nonce})
	token.Header["kid"] = "joined-provider-key"
	signed, err := token.SignedString(o.key)
	if err != nil {
		return nil, deny
	}
	expiry := 3600
	if r.Form.Get("grant_type") == "authorization_code" {
		expiry = 120
	}
	return map[string]any{"access_token": o.access, "refresh_token": o.refresh, "id_token": signed, "token_type": "Bearer", "expires_in": expiry, "scope": "grok-cli:access"}, nil
}
func (o *oauthFixture) authorized(r *http.Request) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.access != "" && r.Header.Get("Authorization") == "Bearer "+o.access
}
func (o *oauthFixture) jwks() map[string]any {
	return map[string]any{"keys": []any{map[string]string{"kty": "EC", "crv": "P-256", "kid": "joined-provider-key", "alg": "ES256", "use": "sig", "x": base64.RawURLEncoding.EncodeToString(o.key.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(o.key.Y.FillBytes(make([]byte, 32)))}}}
}

func main() {
	if run() != nil {
		_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "failed"})
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 {
		return deny
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil || len(raw) > 4096 {
		return deny
	}
	var cfg configuration
	if json.Unmarshal(raw, &cfg) != nil || !strings.HasPrefix(cfg.Consumer, "joined-provider-") || len(cfg.Control) < 32 || len(cfg.Callback) < 32 || len(cfg.Execution) < 32 || len(cfg.Cleanup) < 32 {
		return deny
	}
	dsn, err := url.Parse(cfg.DSN)
	if err != nil || dsn.Hostname() != "127.0.0.1" || dsn.Port() == "" || !strings.HasPrefix(dsn.Path, "/native_provider_joined_") || dsn.RawQuery != "sslmode=disable" || dsn.User == nil || dsn.User.Username() != "postgres" {
		return deny
	}
	db, err := sql.Open("postgres", cfg.DSN)
	if err != nil {
		return deny
	}
	defer db.Close()
	db.SetMaxOpenConns(12)
	var version string
	var count int
	if db.QueryRow(`SELECT current_setting('server_version')`).Scan(&version) != nil || !strings.HasPrefix(version, "17.10") || db.QueryRow(`SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace`).Scan(&count) != nil || count != 0 {
		return deny
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	err = repository.ApplyMigrations(ctx, db)
	cancel()
	if err != nil {
		return deny
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return deny
	}
	oauth := &oauthFixture{key: key}
	countersByProvider := map[string]*counters{"kimi": {}, "glm": {}, "minimax": {}, "grok": {}, "openrouter": {}, "anthropic": {}, "gemini": {}}
	var unexpected atomic.Int64
	var openRouterModelGets atomic.Int64
	var openRouterModelRemoved atomic.Bool
	var toolShapeMu sync.Mutex
	toolShapes := map[string]any{}
	stats := func() map[string]any {
		out := map[string]any{"unexpected": unexpected.Load(), "openrouterModelGets": openRouterModelGets.Load()}
		for name, c := range countersByProvider {
			out[name] = c.snapshot()
		}
		return out
	}
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		reject := func() { unexpected.Add(1); w.WriteHeader(400) }
		if r.Header.Get("Cookie") != "" {
			reject()
			return
		}
		if r.Host == "api.anthropic.com" || r.Host == "generativelanguage.googleapis.com" {
			name := "anthropic"
			if r.Host == "generativelanguage.googleapis.com" {
				name = "gemini"
			}
			if serveOfficial(w, r, name, countersByProvider[name], toolShapes, &toolShapeMu) != nil {
				reject()
			}
			return
		}
		if r.Host == "auth.x.ai" {
			switch r.URL.Path {
			case "/oauth2/token":
				if r.ParseForm() != nil {
					reject()
					return
				}
				if r.Form.Get("grant_type") == "refresh_token" {
					countersByProvider["grok"].refreshes.Add(1)
				} else {
					countersByProvider["grok"].exchanges.Add(1)
				}
				out, err := oauth.issue(r)
				if err != nil {
					reject()
					return
				}
				_ = json.NewEncoder(w).Encode(out)
				return
			case "/.well-known/jwks.json":
				if r.Method != "GET" || r.Header.Get("Authorization") != "" {
					reject()
					return
				}
				_ = json.NewEncoder(w).Encode(oauth.jwks())
				return
			case "/oauth2/userinfo":
				if r.Method != "GET" || !oauth.authorized(r) {
					reject()
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]string{"sub": "joined-provider-subject", "team_id": "", "email": "joined-grok@example.test", "name": "Joined Grok reviewer"})
				return
			default:
				reject()
				return
			}
		}
		if r.Host == "openrouter.ai" && r.Method == "GET" && r.URL.RequestURI() == "/api/v1/models" {
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
				reject()
				return
			}
			openRouterModelGets.Add(1)
			rows := []map[string]any{}
			ids := []string{"birth/anchor"}
			if !openRouterModelRemoved.Load() {
				ids = append(ids, "unseen-vendor/new-model:free")
			}
			for _, id := range ids {
				rows = append(rows, map[string]any{"id": id, "name": id, "context_length": 128000,
					"architecture":         map[string]any{"input_modalities": []string{"text"}, "output_modalities": []string{"text"}},
					"supported_parameters": []string{"tools", "reasoning"}, "reasoning": map[string]any{"supported_efforts": []string{"high", "medium"}, "default_effort": "medium"}, "pricing": map[string]string{"prompt": "0", "completion": "0"}})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": rows})
			return
		}
		name := ""
		switch r.Host {
		case "openrouter.ai":
			name = "openrouter"
		case "api.kimi.ai":
			name = "kimi"
		case "api.z.ai":
			name = "glm"
		case "api.minimax.io", "www.minimax.io":
			name = "minimax"
		case "cli-chat-proxy.grok.com":
			name = "grok"
		default:
			reject()
			return
		}
		c := countersByProvider[name]
		if name == "grok" {
			if !oauth.authorized(r) || r.Header.Get("X-XAI-Token-Auth") != xai.CLITokenAuth {
				reject()
				return
			}
		} else {
			expected := "fixture-provider-key-" + name
			if name != "glm" || r.Method != "GET" {
				expected = "Bearer " + expected
			}
			if r.Header.Get("Authorization") != expected {
				reject()
				return
			}
		}
		if r.Method == "GET" {
			c.quotaGets.Add(1)
			switch name + ":" + r.URL.RequestURI() {
			case "kimi:/coding/v1/usages":
				_, _ = io.WriteString(w, `{"usages":{"limit_5h":{"used_ratio":0.25},"limit_month_total":{"used_ratio":0.5}}}`)
			case "glm:/api/monitor/usage/quota/limit":
				_, _ = io.WriteString(w, `{"success":true,"data":{"level":"GLM Max","limits":[{"type":"CREDIT_LIMIT","unit":3,"percentage":25},{"type":"CREDIT_LIMIT","unit":6,"percentage":50}]}}`)
			case "minimax:/v1/token_plan/remains":
				if r.Host != "www.minimax.io" {
					reject()
					return
				}
				_, _ = io.WriteString(w, `{"base_resp":{"status_code":0},"current_subscribe_title":"MiniMax M Plan Plus","model_remains":[{"model_name":"general","current_interval_remaining_percent":75,"current_weekly_status":1,"current_weekly_remaining_percent":50}]}`)
			case "grok:/v1/billing?format=credits":
				_, _ = io.WriteString(w, `{"config":{"currentPeriod":{"type":"weekly"},"creditUsagePercent":35}}`)
			case "grok:/v1/billing":
				_, _ = io.WriteString(w, `{"config":{"monthlyLimit":{"val":15000},"used":{"val":7500}}}`)
			default:
				reject()
			}
			return
		}
		paths := map[string]string{"kimi": "/coding/v1/responses", "glm": "/api/v1/responses", "minimax": "/v1/responses", "grok": "/v1/responses", "openrouter": "/api/v1/responses"}
		models := map[string]string{"kimi": "k3-256k", "glm": "glm-5.3-flash", "minimax": "MiniMax-M3.1-Flash", "grok": "grok-4.7", "openrouter": "unseen-vendor/new-model:free"}
		c.dispatches.Add(1)
		var body map[string]json.RawMessage
		if r.Method != "POST" || r.URL.RequestURI() != paths[name] || json.NewDecoder(io.LimitReader(r.Body, (4<<20)+1)).Decode(&body) != nil || string(body["model"]) != fmt.Sprintf("%q", models[name]) || string(body["stream"]) != "true" || string(body["store"]) != "false" || body["previous_response_id"] != nil || r.Header.Get("Idempotency-Key") != "" {
			reject()
			return
		}
		if name == "openrouter" {
			var reasoning struct {
				Effort string `json:"effort"`
			}
			if json.Unmarshal(body["reasoning"], &reasoning) != nil || reasoning.Effort != "high" {
				reject()
				return
			}
		}
		if name == "minimax" && body["service_tier"] != nil {
			reject()
			return
		}
		if name == "grok" && (r.Header.Get("x-grok-client-version") != "" || r.Header.Get("x-grok-client-identifier") != xai.ProtectedClientIdentifier || r.Header.Get("x-grok-client-mode") != "" || r.Header.Get("User-Agent") != xai.ProtectedUserAgent) {
			reject()
			return
		}
		var tools []struct {
			Type, Name string
			Parameters json.RawMessage `json:"parameters"`
		}
		if body["tools"] != nil && json.Unmarshal(body["tools"], &tools) != nil {
			reject()
			return
		}
		// The source codec lowers only declared custom tools. Recognize the
		// safe apply_patch shape on provider wire, without inventing any tool.
		customIndex := -1
		for i, tool := range tools {
			if tool.Type != "function" || !strings.HasSuffix(tool.Name, "apply_patch") {
				continue
			}
			var schema struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			}
			if json.Unmarshal(tool.Parameters, &schema) != nil || schema.Properties["input"] == nil {
				continue
			}
			var inputSchema struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(schema.Properties["input"], &inputSchema) != nil || inputSchema.Type != "string" {
				continue
			}
			supported := true
			for _, required := range schema.Required {
				if required != "input" {
					supported = false
				}
			}
			if supported {
				customIndex = i
				break
			}
		}
		c.toolMu.Lock()
		defer c.toolMu.Unlock()
		continuation, err := c.consumeToolContinuation(body["input"])
		if err != nil {
			reject()
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		if name == "grok" {
			w.Header().Set("x-ratelimit-limit-requests", "100")
			w.Header().Set("x-ratelimit-remaining-requests", "75")
			_, _ = io.WriteString(w, "event: ping\ndata: {\"cost\":999}\n\n")
		}
		sequence := 0
		emit := func(event map[string]any) {
			event["sequence_number"] = sequence
			sequence++
			raw, _ := json.Marshal(event)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event["type"], raw)
		}
		response := map[string]any{"id": "joined-response", "object": "response", "status": "in_progress", "model": models[name], "output": []any{}}
		emit(map[string]any{"type": "response.created", "response": response})
		emit(map[string]any{"type": "response.in_progress", "response": response})
		output := []any{}
		if len(tools) > 0 && !continuation {
			selected := -1
			for i, candidate := range tools {
				if candidate.Type == "function" && (candidate.Name == "joined_lookup" || strings.HasSuffix(candidate.Name, "exec_command") || strings.HasSuffix(candidate.Name, "shell_command") || candidate.Name == "shell") {
					selected = i
					if strings.HasSuffix(candidate.Name, "exec_command") {
						break
					}
				}
			}
			if selected < 0 {
				reject()
				return
			}
			tool := tools[selected]
			var schema struct {
				Properties map[string]json.RawMessage `json:"properties"`
				Required   []string                   `json:"required"`
			}
			if json.Unmarshal(tool.Parameters, &schema) != nil {
				reject()
				return
			}
			arguments := "{}"
			if tool.Name != "joined_lookup" {
				args := map[string]any{}
				command := "pwd"
				switch {
				case strings.HasSuffix(tool.Name, "exec_command") && schema.Properties["cmd"] != nil:
					args = map[string]any{"cmd": command, "yield_time_ms": 1000, "max_output_tokens": 1000}
				case strings.HasSuffix(tool.Name, "shell_command") && schema.Properties["command"] != nil:
					args = map[string]any{"command": command, "timeout_ms": 1000}
				case tool.Name == "shell" && schema.Properties["command"] != nil:
					args = map[string]any{"command": []string{"sh", "-lc", command}}
				default:
					reject()
					return
				}
				for property := range args {
					if schema.Properties[property] == nil {
						delete(args, property)
					}
				}
				for _, required := range schema.Required {
					if _, ok := args[required]; !ok {
						reject()
						return
					}
				}
				encoded, e := json.Marshal(args)
				if e != nil {
					reject()
					return
				}
				arguments = string(encoded)
			}
			shape := map[string]any{"name": tool.Name, "type": tool.Type, "requiredProperties": schema.Required}
			emitCall := func(index int, id, callID, name, arguments string) map[string]any {
				item := map[string]any{"type": "function_call", "id": id, "call_id": callID, "name": name, "arguments": "", "status": "in_progress"}
				emit(map[string]any{"type": "response.output_item.added", "output_index": index, "item": item})
				emit(map[string]any{"type": "response.function_call_arguments.delta", "output_index": index, "item_id": id, "delta": arguments})
				emit(map[string]any{"type": "response.function_call_arguments.done", "output_index": index, "item_id": id, "arguments": arguments})
				item["arguments"], item["status"] = arguments, "completed"
				emit(map[string]any{"type": "response.output_item.done", "output_index": index, "item": item})
				return item
			}
			c.pendingTools = &toolContinuation{custom: customIndex >= 0, reasoning: name == "minimax"}
			if name == "minimax" {
				item := map[string]any{"type": "reasoning", "id": "joined-reasoning-1", "summary": []any{}, "content": []any{map[string]any{"type": "reasoning_text", "text": "fixture thought"}}}
				emit(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
				emit(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
				output = append(output, item)
			}
			output = append(output, emitCall(len(output), "joined-item-1", "joined-call-1", tool.Name, arguments))
			c.functionCalls.Add(1)
			if customIndex >= 0 {
				custom := tools[customIndex]
				args, _ := json.Marshal(map[string]string{"input": "*** Begin Patch\n*** End Patch\n"})
				output = append(output, emitCall(len(output), "joined-item-custom", "joined-call-custom", custom.Name, string(args)))
				c.customCalls.Add(1)
				shape["customLoweredFunction"] = map[string]any{"name": custom.Name, "type": custom.Type, "inputProperty": "input"}
			}
			toolShapeMu.Lock()
			toolShapes[name] = shape
			toolShapeMu.Unlock()

		} else {
			item := map[string]any{"id": "joined-message-1", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}
			emit(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": item})
			emit(map[string]any{"type": "response.content_part.added", "output_index": 0, "content_index": 0, "item_id": "joined-message-1", "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})
			emit(map[string]any{"type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "joined-message-1", "delta": `{"findings":[],"revalidations":[]}`})
			emit(map[string]any{"type": "response.output_text.done", "output_index": 0, "content_index": 0, "item_id": "joined-message-1", "text": `{"findings":[],"revalidations":[]}`})
			part := map[string]any{"type": "output_text", "text": `{"findings":[],"revalidations":[]}`, "annotations": []any{}}
			emit(map[string]any{"type": "response.content_part.done", "output_index": 0, "content_index": 0, "item_id": "joined-message-1", "part": part})
			item["status"], item["content"] = "completed", []any{part}
			emit(map[string]any{"type": "response.output_item.done", "output_index": 0, "item": item})
			output = []any{item}
		}
		emit(map[string]any{"type": "response.completed", "response": map[string]any{"id": "joined-response", "object": "response", "status": "completed", "model": models[name], "output": output, "usage": map[string]int{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10}}})

	}))
	defer provider.Close()
	providerTransport := provider.Client().Transport.(*http.Transport).Clone()
	providerTransport.Proxy = nil
	providerTransport.TLSClientConfig.ServerName = "example.com"
	defer providerTransport.CloseIdleConnections()
	providerTransport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		switch address {
		case "openrouter.ai:443", "auth.x.ai:443", "api.kimi.ai:443", "api.z.ai:443", "api.minimax.io:443", "www.minimax.io:443", "cli-chat-proxy.grok.com:443", "api.anthropic.com:443", "generativelanguage.googleapis.com:443":
		default:
			unexpected.Add(1)
			return nil, deny
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, provider.Listener.Addr().String())
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return deny
	}
	custody, err := service.NewGatewayNativeCredentialCustody("joined-provider", map[string][]byte{"joined-provider": secret})
	if err != nil {
		return deny
	}
	grokRepo, err := repository.NewGatewayNativeGrokRepository(db)
	if err != nil {
		return deny
	}
	grok, err := service.NewGatewayNativeGrokOAuth(grokRepo, custody, providerTransport, service.GatewayNativeGrokOAuthQualification{ClientID: "joined-provider-client", RedirectURI: xai.DefaultRedirectURI, DeploymentQualified: true})
	if err != nil {
		return deny
	}
	client := dbent.NewClient(dbent.Driver(entsql.OpenDB(dialect.Postgres, db)))
	defer client.Close()
	accountRepo := repository.NewAccountRepository(client, db, nil)
	adminRepo, ok := accountRepo.(service.AdminAccountRepository)
	if !ok {
		return deny
	}
	adminSvc := service.NewAdminService(nil, nil, nil, adminRepo, nil, nil, nil, nil, nil, nil, nil, nil, nil, client, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	upstream, err := service.NewGatewayNativeLifetimeUpstream(fixtureHTTP{&http.Client{Transport: providerTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}})
	if err != nil {
		return deny
	}
	gateway := service.NewOpenAIGatewayService(accountRepo, nil, nil, nil, nil, nil, nil, &config.Config{}, nil, nil, nil, nil, nil, upstream, nil, nil, nil, nil, nil, nil, nil, nil)
	if gateway.SetGatewayOpenRouterModels(service.NewGatewayOpenRouterModels(providerTransport)) != nil {
		return deny
	}
	cache, ok := repository.NewGatewayAccountLimitsRepositoryV2(db).(service.GatewayAccountQuotaInfoRepository)
	if !ok {
		return deny
	}
	collector := service.NewGatewayProviderQuotaCollector(providerTransport)
	var callback atomic.Value
	callback.Store("")
	post := func(ctx context.Context, path string, body, reply any) error {
		origin := callback.Load().(string)
		if origin == "" {
			return deny
		}
		raw, err := json.Marshal(body)
		if err != nil {
			return deny
		}
		req, err := http.NewRequestWithContext(ctx, "POST", origin+"/private/native/v1/"+path, bytes.NewReader(raw))
		if err != nil {
			return deny
		}
		req.Header.Set("Authorization", "Bearer "+cfg.Callback)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.GetBody = nil
		client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return deny }}
		res, err := client.Do(req)
		if err != nil {
			return deny
		}
		defer res.Body.Close()
		if res.StatusCode != 200 || json.NewDecoder(io.LimitReader(res.Body, 16385)).Decode(reply) != nil {
			return deny
		}
		return nil
	}
	owner := func(ctx context.Context, scope service.GatewayNativeCredentialScope, op, kind string) error {
		var reply struct {
			OK    bool   `json:"ok"`
			Owner string `json:"ownerRef"`
		}
		err := post(ctx, kind, map[string]string{"consumerId": cfg.Consumer, "operationId": op, "accountRef": scope.Account, "generation": scope.Generation}, &reply)
		if err != nil || !reply.OK || reply.Owner != scope.Owner || scope.Consumer != cfg.Consumer {
			return deny
		}
		return nil
	}
	if grok.SetEntryAuthorizers(func(ctx context.Context, s service.GatewayNativeCredentialScope, op string) error {
		return owner(ctx, s, op, "oauth-owner-authority")
	}, func(ctx context.Context, s service.GatewayNativeCredentialScope, op string) error {
		return owner(ctx, s, op, "oauth-refresh-authority")
	}) != nil {
		return deny
	}
	authorize := func(c *gin.Context) {
		if c.Request.Header.Get("Authorization") != "Bearer "+cfg.Control {
			c.AbortWithStatus(403)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(c.Request.Body, admin.GatewayNativeOAuthConnectCompletionBodyLimit+1))
		var tuple struct {
			Operation  string `json:"operation"`
			Owner      string `json:"owner_ref"`
			Account    string `json:"account_ref"`
			Generation string `json:"generation"`
		}
		if err != nil || json.Unmarshal(raw, &tuple) != nil {
			c.AbortWithStatus(400)
			return
		}
		scope := service.GatewayNativeCredentialScope{Consumer: cfg.Consumer, Owner: tuple.Owner, Account: tuple.Account, Generation: tuple.Generation, Purpose: service.GatewayOAuthBundlePurpose}
		kind := "oauth-owner-authority"
		if strings.HasSuffix(c.Request.URL.Path, "/refresh") {
			kind = "oauth-refresh-authority"
		} else if strings.HasSuffix(c.Request.URL.Path, "/connect/custody") {
			kind = "oauth-custody-authority"
		}
		if owner(c.Request.Context(), scope, tuple.Operation, kind) != nil {
			c.AbortWithStatus(403)
			return
		}
		ctx, err := service.WithGatewayNativeConsumer(c.Request.Context(), cfg.Consumer)
		if err == nil {
			ctx, err = service.WithGatewayNativeOAuthOwner(ctx, scope.Owner)
		}
		if err != nil {
			c.AbortWithStatus(403)
			return
		}
		c.Request = c.Request.WithContext(ctx)
		c.Request.Body = io.NopCloser(bytes.NewReader(raw))
		c.Next()
	}
	authorizeAccount := func(kind string) service.GatewayAccountLimitsAuthorizer {
		return func(ctx context.Context, in service.GatewayAccountLimitsInput) (service.GatewayNativeRoute, error) {
			var reply struct {
				OK     bool                       `json:"ok"`
				Native service.GatewayNativeRoute `json:"native"`
			}
			if post(ctx, kind, map[string]any{"consumerId": cfg.Consumer, "ownerRef": in.OwnerRef, "accountRef": in.AccountRef, "profileId": in.ProfileID, "expectedAuthorizationEpoch": in.ExpectedAuthorizationEpoch}, &reply) != nil || !reply.OK {
				return reply.Native, deny
			}
			return reply.Native, nil
		}
	}
	authorizeLimits := authorizeAccount("account-limits-authority")
	reader, err := service.NewGatewayAccountLimitsReaderV2(cache, authorizeLimits)
	if err != nil {
		return deny
	}
	infoReader, err := service.NewGatewayAccountInfoReader(repository.NewGatewayAccountInfoRepository(db), authorizeAccount("account-info-authority"))
	if err != nil {
		return deny
	}
	authorizeLimitsHTTP := func(c *gin.Context) {
		if c.Request.Header.Get("Authorization") != "Bearer "+cfg.Control {
			c.AbortWithStatus(403)
			return
		}
		ctx, err := service.WithGatewayNativeConsumer(c.Request.Context(), cfg.Consumer)
		if err != nil {
			c.AbortWithStatus(403)
			return
		}
		c.Request = c.Request.WithContext(service.WithGatewayNativeCustody(ctx, custody))
		c.Next()
	}
	modelReader, err := service.NewGatewayAccountModelsReader(nil, gateway, authorizeLimits)
	if err != nil {
		return deny
	}
	cleanupAuthority := func(ctx context.Context, in service.GatewayNativeOAuthCleanupRequest) (service.GatewayNativeOAuthCleanupAuthority, error) {
		var reply struct {
			OK     bool                        `json:"ok"`
			Owner  string                      `json:"ownerRef"`
			Lease  string                      `json:"leaseExpiresAt"`
			Native *service.GatewayNativeRoute `json:"native"`
		}
		if post(ctx, "oauth-cleanup-authority", map[string]string{"consumerId": cfg.Consumer, "operationId": in.Operation, "accountRef": in.Scope.Account, "generation": in.Scope.Generation, "cleanupRef": in.CleanupRef, "cleanupToken": in.CleanupToken, "action": in.Action}, &reply) != nil || !reply.OK || reply.Owner != in.Scope.Owner {
			return service.GatewayNativeOAuthCleanupAuthority{}, deny
		}
		lease, e := time.Parse(time.RFC3339Nano, reply.Lease)
		if e != nil || !time.Now().Before(lease) {
			return service.GatewayNativeOAuthCleanupAuthority{}, deny
		}
		return service.GatewayNativeOAuthCleanupAuthority{Owner: reply.Owner, LeaseExpiresAt: lease, Native: reply.Native}, nil
	}
	authorizeCleanup := func(c *gin.Context) {
		if c.Request.Header.Get("Authorization") != "Bearer "+cfg.Cleanup {
			c.AbortWithStatus(403)
			return
		}
		raw, e := io.ReadAll(io.LimitReader(c.Request.Body, 4097))
		var tuple struct {
			Operation    string `json:"operation"`
			Owner        string `json:"owner_ref"`
			Account      string `json:"account_ref"`
			Generation   string `json:"generation"`
			CleanupRef   string `json:"cleanup_ref"`
			CleanupToken string `json:"cleanup_token"`
			Action       string `json:"action"`
		}
		if e != nil || json.Unmarshal(raw, &tuple) != nil {
			c.AbortWithStatus(400)
			return
		}
		in := service.GatewayNativeOAuthCleanupRequest{Scope: service.GatewayNativeCredentialScope{Consumer: cfg.Consumer, Owner: tuple.Owner, Account: tuple.Account, Generation: tuple.Generation, Purpose: service.GatewayOAuthBundlePurpose}, Operation: tuple.Operation, CleanupRef: tuple.CleanupRef, CleanupToken: tuple.CleanupToken, Action: tuple.Action}
		grant, e := cleanupAuthority(c.Request.Context(), in)
		if e != nil || grant.Owner != tuple.Owner {
			c.AbortWithStatus(403)
			return
		}
		ctx, e := service.WithGatewayNativeConsumer(c.Request.Context(), cfg.Consumer)
		if e == nil {
			ctx, e = service.WithGatewayNativeOAuthOwner(ctx, tuple.Owner)
		}
		if e != nil {
			c.AbortWithStatus(403)
			return
		}
		c.Request = c.Request.WithContext(ctx)
		c.Request.Body = io.NopCloser(bytes.NewReader(raw))
		c.Next()
	}
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	const prefix = "/private/native/v1/grok/oauth"
	if admin.RegisterGatewayNativeOAuthCleanupRoute(router.Group(""), grok, authorizeCleanup, cleanupAuthority, prefix) != nil || admin.RegisterGatewayNativeGrokOAuthRoutes(router.Group(""), grok, authorize) != nil || admin.RegisterGatewayNativeOAuthDescriptorRoute(router.Group(""), grok, authorize, prefix) != nil || admin.RegisterGatewayNativeOAuthRetainedCustodyRoute(router.Group(""), grok, authorize, prefix) != nil || admin.RegisterGatewayNativeOAuthRefreshRoute(router.Group(""), grok, authorize, prefix) != nil || admin.RegisterGatewayAccountLimitsRoutesV2(router.Group(""), reader, authorizeLimitsHTTP) != nil || admin.RegisterGatewayAccountModelsRoutes(router.Group(""), modelReader, authorizeLimitsHTTP) != nil {
		return deny
	}
	if admin.RegisterGatewayAccountInfoRoutes(router.Group(""), infoReader, authorizeLimitsHTTP) != nil {
		return deny
	}
	primaryProfile := admin.GatewayNativeProfile{ID: service.GatewayMiMoResponsesProfile, BaseURL: "https://api.openai.com/v1", Model: "fixture-unused"}
	openRouterQualified := gatewaytransport.QualifiedProfile{Profile: service.GatewayOpenRouterResponsesProfile, BaseURL: service.GatewayOpenRouterBaseURL, Model: "birth/anchor", QualificationRef: "controlled-source-v1", RequestBytes: 4 << 20, OutputBytes: 8 << 20, Tokens: 32768, ProviderTokenUpperBound: 32768}
	plans := []gatewaytransport.QualifiedProfile{
		{Profile: service.GatewayKimiCodeResponsesProfile, BaseURL: service.GatewayKimiCodeResponsesBaseURL, Model: service.GatewayKimiCodeResponsesModel},
		{Profile: service.GatewayGLMCodingResponsesProfile, BaseURL: service.GatewayGLMCodingResponsesBaseURL, Model: service.GatewayGLMCodingResponsesModel},
		{Profile: service.GatewayMiniMaxMPlanResponsesProfile, BaseURL: service.GatewayMiniMaxMPlanResponsesBaseURL, Model: service.GatewayMiniMaxMPlanResponsesModel},
	}
	officials := []gatewaytransport.QualifiedProfile{
		{Profile: service.GatewayAnthropicAPIKeyProfile, BaseURL: service.GatewayAnthropicAPIBaseURL, Model: service.GatewayAnthropicAPIModel},
		{Profile: service.GatewayGeminiAPIKeyProfile, BaseURL: service.GatewayGeminiAPIBaseURL, Model: service.GatewayGeminiAPIModel},
	}
	planProfiles := []admin.GatewayNativeProfile{{ID: openRouterQualified.Profile, BaseURL: openRouterQualified.BaseURL, Model: openRouterQualified.Model}}
	for i := range plans {
		plans[i].QualificationRef = "controlled-source-v1"
		plans[i].RequestBytes = 4 << 20
		plans[i].OutputBytes = 8 << 20
		plans[i].Tokens = 32768
		plans[i].ProviderTokenUpperBound = 32768
		planProfiles = append(planProfiles, admin.GatewayNativeProfile{ID: plans[i].Profile, BaseURL: plans[i].BaseURL, Model: plans[i].Model})
	}
	for i := range officials {
		officials[i].QualificationRef = "controlled-source-v1"
		officials[i].RequestBytes = 4 << 20
		officials[i].OutputBytes = 8 << 20
		officials[i].Tokens = 32768
		officials[i].ProviderTokenUpperBound = 32768
		planProfiles = append(planProfiles, admin.GatewayNativeProfile{ID: officials[i].Profile, BaseURL: officials[i].BaseURL, Model: officials[i].Model})
	}
	admin.RegisterGatewayNativeRoutes(router.Group(""), adminSvc, gateway, primaryProfile, authorizeLimitsHTTP, func(*gin.Context, service.GatewayNativeRoute) error { return deny }, func(*gin.Context, bool, error) {}, custody, planProfiles...)
	router.GET("/private/native/v1/account-capabilities", authorizeLimitsHTTP, func(c *gin.Context) {
		profiles := make([]service.GatewayAccountCapability, 0, len(planProfiles)+1)
		for _, profile := range append(append([]admin.GatewayNativeProfile{}, planProfiles...), admin.GatewayNativeProfile{ID: service.GatewayGrokOAuthResponsesProfile, Model: service.GatewayGrokOAuthModel}) {
			capability, ok := service.GatewayNativeAccountCapability(profile.ID, profile.Model, true, false)
			if !ok {
				c.AbortWithStatus(503)
				return
			}
			profiles = append(profiles, capability)
		}
		c.JSON(200, service.GatewayAccountCapabilities{Contract: "native-account-capabilities/v1", Profiles: profiles})
	})
	var private atomic.Pointer[gatewaytransport.Handler]
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler := private.Load()
		if handler == nil {
			w.WriteHeader(503)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/private/native/v1/transports") {
			handler.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == prefix+"/connect/cleanup" {
			handler.CleanupHandler(router).ServeHTTP(w, r)
			return
		}
		handler.ManagementHandler(router).ServeHTTP(w, r)
	}))
	defer native.Close()
	// Controller actions never write account/journal rows directly. They call the
	// same real source custody leases, normalized snapshot writer and eraser.
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+cfg.Control {
			w.WriteHeader(403)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" && r.URL.Path == "/tool-shapes" {
			toolShapeMu.Lock()
			defer toolShapeMu.Unlock()
			_ = json.NewEncoder(w).Encode(toolShapes)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/openrouter/remove-model" {
			openRouterModelRemoved.Store(true)
			w.WriteHeader(204)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/stats" {
			_ = json.NewEncoder(w).Encode(stats())
			return
		}
		if r.Method == "POST" && r.URL.Path == "/grok/authorize" {
			var in struct {
				AuthorizeURL string `json:"authorizeUrl"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 8193)).Decode(&in) != nil {
				w.WriteHeader(400)
				return
			}
			state, err := oauth.authorize(in.AuthorizeURL)
			if err != nil {
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"state": state, "code": "fixture-code"})
			return
		}
		if r.Method != "POST" || (r.URL.Path != "/quotas/collect" && r.URL.Path != "/limits/tombstone") {
			w.WriteHeader(404)
			return
		}
		var in service.GatewayAccountLimitsInput
		if json.NewDecoder(io.LimitReader(r.Body, 2049)).Decode(&in) != nil {
			w.WriteHeader(400)
			return
		}
		bounded, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		route, err := authorizeLimits(bounded, in)
		if err != nil {
			w.WriteHeader(403)
			return
		}
		bounded, err = service.WithGatewayNativeConsumer(bounded, cfg.Consumer)
		if err == nil {
			bounded, err = service.WithGatewayNativeOAuthOwner(bounded, in.OwnerRef)
		}
		if err != nil {
			w.WriteHeader(403)
			return
		}
		purpose := service.GatewayCredentialPurpose
		if route.Profile == service.GatewayGrokOAuthResponsesProfile {
			purpose = service.GatewayOAuthBundlePurpose
		}
		scope := service.GatewayNativeCredentialScope{Consumer: cfg.Consumer, Owner: in.OwnerRef, Account: in.AccountRef, Generation: route.Generation, Purpose: purpose}
		if r.URL.Path == "/quotas/collect" {
			var physical service.GatewayNativeOAuthPhysical
			var observation service.GatewayProviderQuotaObservation
			order, reserveErr := cache.ReserveGatewayAccountInfoOrder(bounded)
			if reserveErr != nil {
				w.WriteHeader(409)
				return
			}
			collect := func(key []byte, current service.GatewayNativeOAuthPhysical) error {
				physical = current
				var e error
				observation, e = collector.FetchWithAccountInfo(bounded, service.GatewayAccountLimitsProviderV2(route.Profile), key)
				return e
			}
			if route.Profile == service.GatewayGrokOAuthResponsesProfile {
				err = grok.WithQuotaCredential(bounded, scope, route, collect)
			} else {
				err = gateway.WithGatewayNativeQuotaCredential(bounded, scope, route, custody, collect)
			}
			var info *service.GatewayAccountInfoObservation
			if observation.Info != nil {
				info = &service.GatewayAccountInfoObservation{Source: "plan_quota", Order: order, CredentialRevision: physical.CredentialRevision, Fields: *observation.Info}
			}
			if err != nil || cache.StoreGatewayQuotaAndInfo(bounded, physical, observation.Limits, observation.ObservedAt, info) != nil {
				w.WriteHeader(409)
				return
			}
			w.WriteHeader(204)
			return
		}
		if route.Profile == service.GatewayGrokOAuthResponsesProfile {
			resolved, operation, e := grokRepo.ResolveGatewayGrokCanonical(bounded, route, in.AccountRef)
			if e != nil || resolved != scope {
				w.WriteHeader(403)
				return
			}
			cleanup := service.GatewayNativeOAuthCleanupRequest{Scope: scope, Operation: operation, Action: "erase", CleanupRef: uuid.NewString(), CleanupToken: uuid.NewString()}
			lease := time.Now().Add(5 * time.Second)
			result, e := grok.Cleanup(bounded, cleanup, func(check context.Context, request service.GatewayNativeOAuthCleanupRequest) (service.GatewayNativeOAuthCleanupAuthority, error) {
				if request != cleanup || !time.Now().Before(lease) {
					return service.GatewayNativeOAuthCleanupAuthority{}, deny
				}
				fresh, e := authorizeLimits(check, in)
				if e != nil || !service.SameGatewayNativeDescriptor(fresh, route) {
					return service.GatewayNativeOAuthCleanupAuthority{}, deny
				}
				return service.GatewayNativeOAuthCleanupAuthority{Owner: scope.Owner, LeaseExpiresAt: lease, Native: &fresh}, nil
			})
			if e != nil || !result.CredentialsErased || result.Closure != "closed" {
				w.WriteHeader(409)
				return
			}
		} else {
			if _, e := adminSvc.UpdateAccount(service.WithGatewayNativeControl(bounded), route.AccountID, &service.UpdateAccountInput{Status: service.StatusDisabled}); e != nil || gateway.EraseGatewayCandidate(bounded, route) != nil {
				w.WriteHeader(409)
				return
			}
		}
		var erased bool
		if db.QueryRowContext(bounded, `SELECT deleted_at IS NOT NULL AND credentials='{}'::jsonb AND NOT EXISTS(SELECT 1 FROM gateway_account_limits_v2_snapshots s WHERE s.account_id=a.id) FROM accounts a WHERE id=$1 AND created_at=$2`, route.AccountID, route.CreatedAt).Scan(&erased) != nil || !erased {
			w.WriteHeader(409)
			return
		}
		w.WriteHeader(204)
	}))
	defer controller.Close()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "nativeOrigin": native.URL, "controllerOrigin": controller.URL})
	scan := bufio.NewScanner(io.LimitReader(os.Stdin, 8192))
	if !scan.Scan() {
		return deny
	}
	var command struct {
		CallbackOrigin    string `json:"callbackOrigin"`
		OriginRef         string `json:"originRef"`
		EngineIncarnation string `json:"engineIncarnation"`
		QualificationRef  string `json:"qualificationRef"`
	}
	if json.Unmarshal(scan.Bytes(), &command) != nil {
		return deny
	}
	origin, err := url.Parse(command.CallbackOrigin)
	if err != nil || origin.Scheme != "http" || origin.Hostname() != "127.0.0.1" || origin.Port() == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || origin.User != nil {
		return deny
	}
	callback.Store(command.CallbackOrigin)
	ack := func(ctx context.Context, path string, body any) error {
		var reply struct {
			OK bool `json:"ok"`
		}
		if post(ctx, path, body, &reply) != nil || !reply.OK {
			return deny
		}
		return nil
	}
	primary := gatewaytransport.QualifiedProfile{Profile: primaryProfile.ID, BaseURL: primaryProfile.BaseURL, Model: primaryProfile.Model, QualificationRef: command.QualificationRef, RequestBytes: 4 << 20, OutputBytes: 8 << 20, Tokens: 32768, ProviderTokenUpperBound: 32768}
	qualified := gatewaytransport.QualifiedProfile{Profile: service.GatewayGrokOAuthResponsesProfile, BaseURL: service.GatewayGrokOAuthBaseURL, Model: service.GatewayGrokOAuthModel, QualificationRef: "controlled-source-v1", RequestBytes: 4 << 20, OutputBytes: 8 << 20, Tokens: 32768, ProviderTokenUpperBound: 32768}
	tcfg := gatewaytransport.Config{Gateway: gateway, Custody: custody, GrokOAuth: grok, Grok: &qualified, OpenRouter: &openRouterQualified, CodingPlans: plans, OfficialAPIs: officials, ProviderLimits: cache, Profile: primary, Enrollment: gatewaytransport.Enrollment{OriginRef: command.OriginRef, EngineIncarnation: command.EngineIncarnation, QualificationRef: primary.QualificationRef}, CallbackOrigin: command.CallbackOrigin, CallbackCredential: cfg.Callback, CallbackTimeout: 4 * time.Second, IOTimeout: 5 * time.Second, ProviderReadIdle: 5 * time.Second, CleanupTimeout: 4 * time.Second, MaxEntries: 32, EnvelopeBytes: 5 << 20, CallbackBytes: 16384,
		Authorize: func(r *http.Request) (gatewaytransport.Peer, error) {
			token := r.Header.Get("Authorization")
			if token == "Bearer "+cfg.Control {
				return gatewaytransport.Peer{ConsumerID: cfg.Consumer, Role: "management"}, nil
			}
			if token == "Bearer "+cfg.Execution {
				return gatewaytransport.Peer{ConsumerID: cfg.Consumer, Role: "execution"}, nil
			}
			if token == "Bearer "+cfg.Cleanup {
				return gatewaytransport.Peer{ConsumerID: cfg.Consumer, Role: "cleanup"}, nil
			}
			return gatewaytransport.Peer{}, deny
		},
		VerifyEnrollment: func(ctx context.Context, e gatewaytransport.Enrollment) error {
			return ack(ctx, "enrollment", map[string]string{"originRef": e.OriginRef, "engineIncarnation": e.EngineIncarnation, "qualificationRef": e.QualificationRef})
		},
		VerifyDispatch: func(ctx context.Context, consumer string, p gatewaytransport.Proof, lease time.Time) error {
			return ack(ctx, "dispatch-proof", map[string]any{"consumerId": consumer, "proof": p, "leaseExpiresAt": lease.UTC().Format(time.RFC3339Nano)})
		},
		AuthorizeCleanup: func(ctx context.Context, consumer string, p gatewaytransport.Proof, l gatewaytransport.CleanupLease) error {
			return ack(ctx, "cleanup-authority", map[string]any{"consumerId": consumer, "proof": p, "cleanup": l})
		},
		AcknowledgeClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof, l gatewaytransport.CleanupLease, r gatewaytransport.Receipt) error {
			return ack(ctx, "closure-ack", map[string]any{"consumerId": consumer, "proof": p, "cleanup": l, "receipt": r})
		},
		AuthorizeOwnerClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof) error {
			return ack(ctx, "owner-closure-authority", map[string]any{"consumerId": consumer, "proof": p})
		},
		AcknowledgeOwnerClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof, r gatewaytransport.Receipt) error {
			return ack(ctx, "closure-ack", map[string]any{"consumerId": consumer, "proof": p, "receipt": r})
		},
	}
	handler, err := gatewaytransport.New(context.Background(), tcfg)
	if err != nil {
		return deny
	}
	private.Store(handler)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = handler.Stop(ctx)
	}()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "configured"})
	if !scan.Scan() || scan.Text() != "stop" {
		return deny
	}
	var material, credentials, retainedCredentials int
	if db.QueryRow(`SELECT count(*) FROM gateway_grok_connect_intents WHERE material_envelope<>''`).Scan(&material) != nil || db.QueryRow(`SELECT count(*) FROM accounts WHERE credentials::text LIKE '%fixture-provider-key-%' OR credentials::text LIKE '%joined-grok-access-%' OR credentials::text LIKE '%joined-grok-refresh-%'`).Scan(&credentials) != nil || material != 0 || credentials != 0 {
		return deny
	}
	if db.QueryRow(`SELECT count(*) FROM accounts WHERE
 (extra ? 'gateway_grok_profile_v1' AND credentials<>'{}'::jsonb)
 OR (extra ? 'gateway_profile_v1' AND
  (CASE WHEN jsonb_typeof(credentials)='object' THEN
   credentials-'base_url'='{}'::jsonb AND credentials->>'base_url'=CASE extra->>'gateway_profile_v1'
    WHEN 'openrouter-openai-responses-apikey-v1' THEN 'https://openrouter.ai/api/v1'
    WHEN 'kimi-code-global-responses-apikey-v1' THEN 'https://api.kimi.ai/coding/v1'
    WHEN 'glm-coding-global-responses-apikey-v1' THEN 'https://api.z.ai/api/v1'
    WHEN 'minimax-mplan-global-responses-apikey-v1' THEN 'https://api.minimax.io/v1'
    WHEN 'anthropic-messages-apikey-v1' THEN 'https://api.anthropic.com/v1'
    WHEN 'gemini-openai-chat-apikey-v1' THEN 'https://generativelanguage.googleapis.com/v1beta/openai'
   END
  ELSE false END) IS DISTINCT FROM TRUE)`).Scan(&retainedCredentials) != nil || retainedCredentials != 0 {
		return deny
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"event": "closed", "counts": stats(), "plaintextCredentials": credentials, "retainedOAuthMaterial": material, "retainedCredentials": retainedCredentials})
	return nil
}
