// Test-only composition built beneath the real native module. It runs the real
// Claude lifecycle, SQL, custody, private transport and Responses/Messages seam.
// The only provider is a disposable local TLS server; no live credentials run.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/gatewaytransport"
	"github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/oauth"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

type configuration struct {
	DSN, Consumer, Control, Callback, Execution, Cleanup string
	CLI                                                  bool
}
type counts struct {
	Exchanges  int64 `json:"exchanges"`
	Refreshes  int64 `json:"refreshes"`
	Messages   int64 `json:"messages"`
	Unexpected int64 `json:"unexpected"`
}

var deny = errors.New("joined Claude fixture refused")

type fixtureHTTP struct{ client *http.Client }

func (u fixtureHTTP) Do(r *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	return u.client.Do(r)
}
func (u fixtureHTTP) DoWithTLS(r *http.Request, p string, id int64, c int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(r, p, id, c)
}

// Assert the maintained OAuth wire independently of the source builder. The
// exact caller instructions remain system text and no synthetic turns appear.
func validClaudeOAuthHeaders(r *http.Request) bool {
	ua := r.Header.Get("User-Agent")
	if r.URL.RawQuery != "beta=true" || !regexp.MustCompile(`^claude-cli/[0-9]+\.[0-9]+\.[0-9]+ \(external, cli\)$`).MatchString(ua) ||
		r.Header.Get("X-App") != "cli" || r.Header.Get("X-Stainless-Lang") != "js" || r.Header.Get("X-Stainless-Runtime") != "node" || r.Header.Get("X-Stainless-Retry-Count") != "0" {
		return false
	}
	betas := "," + r.Header.Get("anthropic-beta") + ","
	for _, beta := range []string{"claude-code-20250219", "oauth-2025-04-20", "context-management-2025-06-27", "effort-2025-11-24", "extended-cache-ttl-2025-04-11"} {
		if !strings.Contains(betas, ","+beta+",") {
			return false
		}
	}
	return true
}

func validClaudeOAuthWire(r *http.Request, body map[string]json.RawMessage) bool {
	if !validClaudeOAuthHeaders(r) {
		return false
	}
	ua := r.Header.Get("User-Agent")
	var system []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(body["system"], &system) != nil || len(system) != 4 {
		return false
	}
	version := strings.TrimSuffix(strings.TrimPrefix(ua, "claude-cli/"), " (external, cli)")
	if !strings.Contains(system[0].Text, "cc_version="+version+".") || !strings.Contains(system[0].Text, "cc_entrypoint=cli;") ||
		system[1].Text != "You are Claude Code, Anthropic's official CLI for Claude." || !strings.Contains(system[2].Text, "You are an interactive agent") ||
		system[3].Text != "Controlled fixture system instructions stay at system priority." {
		return false
	}
	var messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) != 1 || messages[0].Role != "user" || messages[0].Content != "Controlled disposable fixture" {
		return false
	}
	return string(body["max_tokens"]) == "100" && string(body["temperature"]) == "1" && string(body["tools"]) == "[]"
}

func validClaudeCLIWire(r *http.Request, raw []byte, body map[string]json.RawMessage) bool {
	if !validClaudeOAuthHeaders(r) || service.ValidateGatewayNativeClaudeMessagesBounded(raw, 1<<20, 65536) != nil ||
		string(body["max_tokens"]) != "32000" || string(body["tools"]) != "[]" {
		return false
	}
	var messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(body["messages"], &messages) != nil || len(messages) != 1 || messages[0].Role != "user" {
		return false
	}
	var text string
	if json.Unmarshal(messages[0].Content, &text) == nil {
		return text == "Return the local fixture answer."
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	return json.Unmarshal(messages[0].Content, &blocks) == nil && len(blocks) == 1 && blocks[0].Type == "text" && blocks[0].Text == "Return the local fixture answer."
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
	if json.Unmarshal(raw, &cfg) != nil || !strings.HasPrefix(cfg.Consumer, "joined-claude-") || len(cfg.Control) < 32 || len(cfg.Callback) < 32 || len(cfg.Execution) < 32 || len(cfg.Cleanup) < 32 {
		return deny
	}
	if cfg.CLI {
		interfaces, err := net.Interfaces()
		if err != nil || len(interfaces) != 1 || interfaces[0].Name != "lo" {
			return deny
		}
		routes, err := os.ReadFile("/proc/net/route")
		if err != nil || len(strings.Split(strings.TrimSpace(string(routes)), "\n")) != 1 {
			return deny
		}
		probe, err := net.DialTimeout("tcp", "192.0.2.1:443", 500*time.Millisecond)
		if probe != nil {
			_ = probe.Close()
			return deny
		}
		if !errors.Is(err, syscall.ENETUNREACH) {
			return deny
		}
	}
	dsn, err := url.Parse(cfg.DSN)
	if err != nil || dsn.Hostname() != "127.0.0.1" || dsn.Port() == "" || !strings.HasPrefix(dsn.Path, "/native_claude_joined_") || dsn.RawQuery != "sslmode=disable" || dsn.User == nil || dsn.User.Username() != "postgres" {
		return deny
	}
	db, err := sql.Open("postgres", cfg.DSN)
	if err != nil {
		return deny
	}
	defer db.Close()
	db.SetMaxOpenConns(8)
	if cfg.CLI {
		db.SetMaxOpenConns(4)
	}
	var version string
	var count int
	if db.QueryRow(`SELECT current_setting('server_version')`).Scan(&version) != nil || !strings.HasPrefix(version, "17.10") || db.QueryRow(`SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace`).Scan(&count) != nil || count != 0 {
		return deny
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	err = repository.ApplyMigrations(ctx, db)
	cancel()
	if err != nil {
		return deny
	}
	access, refresh := "joined-claude-access-"+uuid.NewString(), "joined-claude-refresh-"+uuid.NewString()
	account, organization := uuid.NewString(), uuid.NewString()
	var exchanges, refreshes, messages, unexpected atomic.Int64
	stats := func() counts { return counts{exchanges.Load(), refreshes.Load(), messages.Load(), unexpected.Load()} }
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/oauth/token":
			var body map[string]string
			if r.Host != "platform.claude.com" || r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body["client_id"] != oauth.ClientID || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			switch body["grant_type"] {
			case "authorization_code":
				exchanges.Add(1)
				if body["code"] != "fixture-code" || body["state"] == "" || len(body["code_verifier"]) < 40 || body["redirect_uri"] != oauth.RedirectURI {
					unexpected.Add(1)
					w.WriteHeader(400)
					return
				}
			case "refresh_token":
				refreshes.Add(1)
				if body["refresh_token"] != refresh {
					unexpected.Add(1)
					w.WriteHeader(400)
					return
				}
			default:
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 3600, "scope": "user:inference user:profile", "account": map[string]string{"uuid": account}, "organization": map[string]string{"uuid": organization}})
		case "/v1/messages":
			messages.Add(1)
			raw, readErr := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
			var body map[string]json.RawMessage
			if readErr != nil || len(raw) > 1<<20 || r.Host != "api.anthropic.com" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+access || r.Header.Get("X-Api-Key") != "" || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("Cookie") != "" || json.Unmarshal(raw, &body) != nil || string(body["model"]) != `"claude-sonnet-4-6"` || string(body["stream"]) != "true" || body["messages"] == nil || body["input"] != nil || body["store"] != nil {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			if cfg.CLI && !validClaudeCLIWire(r, raw, body) || !cfg.CLI && !validClaudeOAuthWire(r, body) {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("anthropic-ratelimit-unified-5h-utilization", "0.375")
			w.Header().Set("anthropic-ratelimit-unified-5h-reset", "1792700000")
			w.Header().Set("anthropic-ratelimit-unified-7d-utilization", "0.625")
			w.Header().Set("anthropic-ratelimit-unified-7d-reset", "1793000000")
			_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_joined_claude\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-6\",\"content\":[],\"usage\":{\"input_tokens\":7,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"joined Claude answer\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":3}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
		default:
			unexpected.Add(1)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	providerTransport := provider.Client().Transport.(*http.Transport).Clone()
	providerTransport.Proxy = nil
	providerTransport.TLSClientConfig.ServerName = "example.com"
	defer providerTransport.CloseIdleConnections()
	providerTransport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "platform.claude.com:443" && address != "api.anthropic.com:443" {
			unexpected.Add(1)
			return nil, deny
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, provider.Listener.Addr().String())
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return deny
	}
	custody, err := service.NewGatewayNativeCredentialCustody("joined-claude", map[string][]byte{"joined-claude": secret})
	if err != nil {
		return deny
	}
	claudeRepo, err := repository.NewGatewayNativeClaudeRepository(db)
	if err != nil {
		return deny
	}
	claude, err := service.NewGatewayNativeClaudeOAuth(claudeRepo, custody, providerTransport)
	if err != nil {
		return deny
	}
	accountRepo := repository.NewAccountRepository(nil, db, nil)
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
	if claude.SetEntryAuthorizers(func(ctx context.Context, s service.GatewayNativeCredentialScope, op string) error {
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
	authorizeLimits := func(ctx context.Context, in service.GatewayAccountLimitsInput) (service.GatewayNativeRoute, error) {
		var reply struct {
			OK     bool                       `json:"ok"`
			Native service.GatewayNativeRoute `json:"native"`
		}
		if post(ctx, "account-limits-authority", map[string]any{"consumerId": cfg.Consumer, "ownerRef": in.OwnerRef, "accountRef": in.AccountRef, "profileId": in.ProfileID, "expectedAuthorizationEpoch": in.ExpectedAuthorizationEpoch}, &reply) != nil || !reply.OK {
			return reply.Native, deny
		}
		return reply.Native, nil
	}
	reader, err := service.NewGatewayAccountLimitsReader(accountRepo.(service.GatewayAccountLimitsCache), authorizeLimits)
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
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	prefix := "/private/native/v1/claude/oauth"
	if admin.RegisterGatewayNativeClaudeOAuthRoutes(router.Group(""), claude, authorize) != nil || admin.RegisterGatewayNativeOAuthDescriptorRoute(router.Group(""), claude, authorize, prefix) != nil || admin.RegisterGatewayNativeOAuthRetainedCustodyRoute(router.Group(""), claude, authorize, prefix) != nil || admin.RegisterGatewayNativeOAuthRefreshRoute(router.Group(""), claude, authorize, prefix) != nil || admin.RegisterGatewayAccountLimitsRoutes(router.Group(""), reader, authorizeLimitsHTTP) != nil {
		return deny
	}
	var private atomic.Pointer[gatewaytransport.Handler]
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/private/native/v1/transports") {
			handler := private.Load()
			if handler == nil {
				w.WriteHeader(503)
				return
			}
			handler.ServeHTTP(w, r)
			return
		}
		router.ServeHTTP(w, r)
	}))
	defer native.Close()
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+cfg.Control {
			w.WriteHeader(403)
			return
		}
		if r.Method == "GET" && r.URL.Path == "/stats" {
			_ = json.NewEncoder(w).Encode(stats())
			return
		}
		if r.Method == "POST" && r.URL.Path == "/limits/tombstone" {
			var in service.GatewayAccountLimitsInput
			if json.NewDecoder(io.LimitReader(r.Body, 1025)).Decode(&in) != nil {
				w.WriteHeader(400)
				return
			}
			route, err := authorizeLimits(r.Context(), in)
			if err != nil {
				w.WriteHeader(403)
				return
			}
			ctx, err := service.WithGatewayNativeConsumer(r.Context(), cfg.Consumer)
			if err != nil {
				w.WriteHeader(403)
				return
			}
			scope, operation, err := claudeRepo.ResolveGatewayClaudeCanonical(ctx, route, in.AccountRef)
			if err != nil || scope.Owner != in.OwnerRef {
				w.WriteHeader(403)
				return
			}
			ctx, err = service.WithGatewayNativeOAuthOwner(ctx, scope.Owner)
			if err != nil {
				w.WriteHeader(403)
				return
			}
			// This protected fixture controller requests the real source custody
			// eraser. It never bypasses the account/intent guards with raw SQL.
			// Recheck the live Gateway owner/mapping at both cleanup fences.
			cleanup := service.GatewayNativeOAuthCleanupRequest{Scope: scope, Operation: operation, Action: "erase", CleanupRef: uuid.NewString(), CleanupToken: uuid.NewString()}
			lease := time.Now().Add(5 * time.Second)
			result, err := claude.Cleanup(ctx, cleanup, func(checkCtx context.Context, request service.GatewayNativeOAuthCleanupRequest) (service.GatewayNativeOAuthCleanupAuthority, error) {
				if request != cleanup || !time.Now().Before(lease) {
					return service.GatewayNativeOAuthCleanupAuthority{}, deny
				}
				fresh, err := authorizeLimits(checkCtx, in)
				if err != nil || !service.SameGatewayNativeDescriptor(fresh, route) {
					return service.GatewayNativeOAuthCleanupAuthority{}, deny
				}
				return service.GatewayNativeOAuthCleanupAuthority{Owner: scope.Owner, LeaseExpiresAt: lease, Native: &fresh}, nil
			})
			if err != nil || !result.CredentialsErased || result.Closure != "closed" || result.Native == nil || !service.SameGatewayNativeDescriptor(*result.Native, route) {
				w.WriteHeader(409)
				return
			}
			var erased bool
			if db.QueryRowContext(ctx, `SELECT a.deleted_at IS NOT NULL AND a.credentials='{}'::jsonb AND c.state='erased' AND c.material_envelope='' AND NOT EXISTS(SELECT 1 FROM gateway_claude_limits_snapshots s WHERE s.account_id=a.id) FROM accounts a JOIN gateway_claude_connect_intents c ON c.account_id=a.id AND c.native_created_at=a.created_at WHERE a.id=$1 AND a.created_at=$2`, route.AccountID, route.CreatedAt).Scan(&erased) != nil || !erased {
				w.WriteHeader(409)
				return
			}
			w.WriteHeader(204)
			return
		}
		w.WriteHeader(404)
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
	if err != nil || origin.Scheme != "http" || origin.Hostname() != "127.0.0.1" || origin.Port() == "" || origin.Path != "" {
		return deny
	}
	callback.Store(command.CallbackOrigin)
	upstream, err := service.NewGatewayNativeLifetimeUpstream(fixtureHTTP{&http.Client{Transport: providerTransport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}})
	if err != nil {
		return deny
	}
	gateway := service.NewOpenAIGatewayService(accountRepo, nil, nil, nil, nil, nil, nil, &config.Config{}, nil, nil, nil, nil, nil, upstream, nil, nil, nil, nil, nil, nil, nil, nil)
	ack := func(ctx context.Context, path string, body any) error {
		var reply struct {
			OK bool `json:"ok"`
		}
		if post(ctx, path, body, &reply) != nil || !reply.OK {
			return deny
		}
		return nil
	}
	primary := gatewaytransport.QualifiedProfile{Profile: service.GatewayMiMoResponsesProfile, Model: "fixture-unused", BaseURL: "https://api.openai.com/v1", QualificationRef: command.QualificationRef, RequestBytes: 4096, OutputBytes: 4096, Tokens: 100, ProviderTokenUpperBound: 100}
	qualified := gatewaytransport.QualifiedProfile{Profile: service.GatewayClaudeOAuthMessagesProfile, Model: service.GatewayClaudeOAuthModel, BaseURL: service.GatewayClaudeOAuthBaseURL, QualificationRef: "controlled-source-v1", RequestBytes: 4096, OutputBytes: 4096, Tokens: 100, ProviderTokenUpperBound: 100}
	if cfg.CLI {
		qualified.RequestBytes, qualified.OutputBytes, qualified.Tokens, qualified.ProviderTokenUpperBound = 1<<20, 1<<20, 65536, 65536
	}
	tcfg := gatewaytransport.Config{Gateway: gateway, Custody: custody, ClaudeOAuth: claude, Claude: &qualified, Profile: primary, Enrollment: gatewaytransport.Enrollment{OriginRef: command.OriginRef, EngineIncarnation: command.EngineIncarnation, QualificationRef: primary.QualificationRef}, CallbackOrigin: command.CallbackOrigin, CallbackCredential: cfg.Callback, CallbackTimeout: 4 * time.Second, IOTimeout: 5 * time.Second, ProviderReadIdle: 5 * time.Second, CleanupTimeout: 4 * time.Second, MaxEntries: 8, EnvelopeBytes: 8192, CallbackBytes: 16384,
		Authorize: func(r *http.Request) (gatewaytransport.Peer, error) {
			token := r.Header.Get("Authorization")
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
	var public *httptest.Server
	if cfg.CLI {
		public = httptest.NewServer(handler.PublicHandler(2))
		defer public.Close()
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = handler.Stop(ctx)
	}()
	configured := map[string]string{"event": "configured"}
	if public != nil {
		configured["inferenceOrigin"] = public.URL
	}
	_ = json.NewEncoder(os.Stdout).Encode(configured)
	if !scan.Scan() || scan.Text() != "stop" {
		return deny
	}
	var material, credentials int
	if db.QueryRow(`SELECT count(*) FROM gateway_claude_connect_intents WHERE material_envelope<>''`).Scan(&material) != nil || db.QueryRow(`SELECT count(*) FROM accounts WHERE credentials::text LIKE $1 OR credentials::text LIKE $2`, "%"+access+"%", "%"+refresh+"%").Scan(&credentials) != nil || material != 0 || credentials != 0 {
		return deny
	}
	if cfg.CLI && (db.Stats().InUse != 0 || stats().Messages != 1 || stats().Unexpected != 0) {
		return deny
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"event": "closed", "counts": stats(), "plaintextCredentials": credentials, "retainedOAuthMaterial": material})
	return nil
}
