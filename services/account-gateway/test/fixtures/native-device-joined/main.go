// Test-only composition copied beneath the real native Go module before build.
// Production HTTP handlers, service transitions, SQL and credential custody are
// used unchanged. Only provider transport and live authority wiring are fixtures.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/gatewaytransport"
	"github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

type configuration struct {
	DSN, Consumer, Control, Callback, Execution, Cleanup string
	CLI                                                  bool
}
type counters struct {
	Starts     int64 `json:"starts"`
	Polls      int64 `json:"polls"`
	Exchanges  int64 `json:"exchanges"`
	Checks     int64 `json:"checks"`
	Unexpected int64 `json:"unexpected"`
}

var deny = errors.New("joined fixture refused")

type fixtureHTTP struct{ client *http.Client }

func (u fixtureHTTP) Do(r *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	return u.client.Do(r)
}
func (u fixtureHTTP) DoWithTLS(r *http.Request, p string, id int64, c int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(r, p, id, c)
}

func main() {
	if err := run(); err != nil {
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
	if json.Unmarshal(raw, &cfg) != nil || !strings.HasPrefix(cfg.Consumer, "joined-device-") || len(cfg.Control) < 32 || len(cfg.Callback) < 32 {
		return deny
	}
	if cfg.CLI && (len(cfg.Execution) < 32 || len(cfg.Cleanup) < 32) {
		return deny
	}
	u, err := url.Parse(cfg.DSN)
	if err != nil || u.Hostname() != "127.0.0.1" || u.Port() == "" || !strings.HasPrefix(u.Path, "/native_device_joined_") || u.RawQuery != "sslmode=disable" || (u.User == nil || u.User.Username() != "postgres") {
		return deny
	}
	db, err := sql.Open("postgres", cfg.DSN)
	if err != nil {
		return deny
	}
	defer db.Close()
	db.SetMaxOpenConns(6)
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
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return deny
	}
	id := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": service.GatewayOAuthIssuer, "sub": "joined-device-principal", "aud": openai.ClientID, "exp": time.Now().Add(time.Hour).Unix()})
	id.Header["kid"] = "joined-device"
	idToken, err := id.SignedString(key)
	if err != nil {
		return deny
	}
	access, refresh := "joined-fake-access-"+uuid.NewString(), "joined-fake-refresh-"+uuid.NewString()
	verifier := strings.Repeat("v", 64)
	providerAccount := uuid.NewString()
	var starts, polls, exchanges, checks, unexpected, inferenceEntries atomic.Int64
	var authorized atomic.Bool
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/jwks.json":
			_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kid": "joined-device", "kty": "RSA", "alg": "RS256", "use": "sig", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB"}}})
		case "/api/accounts/deviceauth/usercode":
			starts.Add(1)
			var body map[string]string
			if r.Host != "auth.openai.com" || r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body["client_id"] != openai.ClientID || len(body) != 1 {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"device_auth_id": "joined-native-device-id", "user_code": "JOIN-ED42", "interval": "1", "expires_in": 600})
		case "/api/accounts/deviceauth/token":
			polls.Add(1)
			var body map[string]string
			if r.Host != "auth.openai.com" || r.Method != "POST" || json.NewDecoder(r.Body).Decode(&body) != nil || body["device_auth_id"] != "joined-native-device-id" || body["user_code"] != "JOIN-ED42" || len(body) != 2 {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			if !authorized.Load() {
				w.WriteHeader(403)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"authorization_code": "joined-native-authorization-code", "code_verifier": verifier, "code_challenge": openai.GenerateCodeChallenge(verifier)})
		case "/oauth/token":
			exchanges.Add(1)
			if r.Host != "auth.openai.com" || r.Method != "POST" || r.ParseForm() != nil || len(r.PostForm) != 5 || r.PostForm.Get("grant_type") != "authorization_code" || r.PostForm.Get("code") != "joined-native-authorization-code" || r.PostForm.Get("code_verifier") != verifier || r.PostForm.Get("client_id") != openai.ClientID || r.PostForm.Get("redirect_uri") != service.GatewayOAuthDeviceRedirect || r.Header.Get("Cookie") != "" || r.Header.Get("Authorization") != "" {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": access, "refresh_token": refresh, "id_token": idToken, "token_type": "Bearer", "expires_in": 3600, "scope": openai.DefaultScopes})
		case "/backend-api/accounts/check/v4-2023-04-27":
			checks.Add(1)
			if r.Host != "chatgpt.com" || r.Header.Get("Authorization") != "Bearer "+access {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"accounts": map[string]any{"fixture": map[string]any{"account": map[string]any{"account_id": providerAccount, "is_default": true}, "entitlement": map[string]any{"expires_at": time.Now().Add(time.Hour).Format(time.RFC3339Nano)}}}})
		case "/backend-api/codex/responses":
			inferenceEntries.Add(1)
			body, readErr := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
			var input struct {
				Model  string `json:"model"`
				Stream bool   `json:"stream"`
			}
			if !cfg.CLI || r.Host != "chatgpt.com" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+access || r.Header.Get("ChatGPT-Account-Id") != providerAccount ||
				readErr != nil || len(body) > 1<<20 || json.Unmarshal(body, &input) != nil || input.Model != service.GatewayCodexOAuthModel || !input.Stream {
				unexpected.Add(1)
				w.WriteHeader(400)
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, codexCLISSE())
		default:
			unexpected.Add(1)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	transport := provider.Client().Transport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	transport.Proxy = nil
	transport.TLSClientConfig.ServerName = "example.com"
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "auth.openai.com:443" && address != "chatgpt.com:443" {
			unexpected.Add(1)
			return nil, deny
		}
		return (&net.Dialer{Timeout: time.Second}).DialContext(ctx, network, provider.Listener.Addr().String())
	}
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return deny
	}
	custody, err := service.NewGatewayNativeCredentialCustody("joined", map[string][]byte{"joined": secret})
	if err != nil {
		return deny
	}
	nativeVerifier := service.NewGatewayNativeOAuthVerifier(transport)
	accountRepo := repository.NewAccountRepository(nil, db, nil)
	enrollRepo := accountRepo.(service.GatewayNativeOAuthRepository)
	enrollment, err := service.NewGatewayNativeOAuthEnrollment(nativeVerifier, custody, enrollRepo, secret)
	if err != nil {
		return deny
	}
	connectRepo, err := repository.NewGatewayNativeOAuthConnectRepository(db)
	if err != nil {
		return deny
	}
	connect, err := service.NewGatewayNativeOAuthConnect(secret, transport, connectRepo, enrollment, enrollRepo)
	if err != nil {
		return deny
	}
	dispatch, err := service.NewGatewayNativeOAuthDispatch(accountRepo.(service.GatewayNativeOAuthDispatchRepository), custody, nativeVerifier, transport)
	if err != nil {
		return deny
	}
	refreshService, err := service.NewGatewayNativeOAuthRefresh(accountRepo.(service.GatewayNativeOAuthRefreshRepository), custody, nativeVerifier, transport)
	if err != nil {
		return deny
	}
	var callback atomic.Value
	callback.Store("")
	authorizeScope := func(ctx context.Context, scope service.GatewayNativeCredentialScope, operation, kind string) error {
		origin := callback.Load().(string)
		if origin == "" || scope.Consumer != cfg.Consumer {
			return deny
		}
		body, _ := json.Marshal(map[string]string{"consumerId": cfg.Consumer, "operationId": operation, "accountRef": scope.Account, "generation": scope.Generation})
		req, err := http.NewRequestWithContext(ctx, "POST", origin+"/private/native/v1/"+kind, bytes.NewReader(body))
		if err != nil {
			return deny
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+cfg.Callback)
		client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return deny }}
		resp, err := client.Do(req)
		if err != nil {
			return deny
		}
		defer resp.Body.Close()
		var result struct {
			OK    bool   `json:"ok"`
			Owner string `json:"ownerRef"`
		}
		if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 2049)).Decode(&result) != nil || !result.OK || result.Owner != scope.Owner {
			return deny
		}
		return nil
	}
	authorize := func(c *gin.Context) {
		if c.Request.Header.Get("Authorization") != "Bearer "+cfg.Control {
			c.AbortWithStatus(403)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 4097))
		var tuple struct {
			Operation  string `json:"operation"`
			Owner      string `json:"owner_ref"`
			Account    string `json:"account_ref"`
			Generation string `json:"generation"`
		}
		if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &tuple) != nil {
			c.AbortWithStatus(400)
			return
		}
		scope := service.GatewayNativeCredentialScope{Consumer: cfg.Consumer, Owner: tuple.Owner, Account: tuple.Account, Generation: tuple.Generation, Purpose: service.GatewayOAuthBundlePurpose}
		kind := "oauth-owner-authority"
		if c.Request.URL.Path == "/private/native/v1/oauth/refresh" {
			kind = "oauth-refresh-authority"
		}
		if authorizeScope(c.Request.Context(), scope, tuple.Operation, kind) != nil {
			c.AbortWithStatus(403)
			return
		}
		ctx, err := service.WithGatewayNativeConsumer(c.Request.Context(), cfg.Consumer)
		if err == nil {
			ctx, err = service.WithGatewayNativeOAuthOwner(ctx, tuple.Owner)
		}
		if err != nil {
			c.AbortWithStatus(403)
			return
		}
		c.Request = c.Request.WithContext(ctx)
		c.Request.Body = io.NopCloser(bytes.NewReader(raw))
		c.Next()
	}
	if connect.SetEntryAuthorizer(func(ctx context.Context, scope service.GatewayNativeCredentialScope, operation string) error {
		return authorizeScope(ctx, scope, operation, "oauth-owner-authority")
	}) != nil {
		return deny
	}
	authorizeLimits := func(ctx context.Context, in service.GatewayAccountLimitsInput) (service.GatewayNativeRoute, error) {
		var result struct {
			OK     bool                       `json:"ok"`
			Native service.GatewayNativeRoute `json:"native"`
		}
		body, _ := json.Marshal(map[string]any{"consumerId": cfg.Consumer, "ownerRef": in.OwnerRef, "accountRef": in.AccountRef, "profileId": in.ProfileID, "expectedAuthorizationEpoch": in.ExpectedAuthorizationEpoch})
		req, err := http.NewRequestWithContext(ctx, "POST", callback.Load().(string)+"/private/native/v1/account-limits-authority", bytes.NewReader(body))
		if err != nil {
			return result.Native, deny
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+cfg.Callback)
		client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return deny }}
		resp, err := client.Do(req)
		if err != nil {
			return result.Native, deny
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 || json.NewDecoder(io.LimitReader(resp.Body, 4097)).Decode(&result) != nil || !result.OK {
			return result.Native, deny
		}
		return result.Native, nil
	}
	limitsReader, err := service.NewGatewayAccountLimitsReader(accountRepo.(service.GatewayAccountLimitsRepository), authorizeLimits)
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
	if admin.RegisterGatewayNativeOAuthConnectRoutes(router.Group(""), connect, authorize) != nil || admin.RegisterGatewayNativeOAuthDescriptorRoute(router.Group(""), dispatch, authorize) != nil || admin.RegisterGatewayNativeOAuthRefreshRoute(router.Group(""), refreshService, authorize) != nil {
		return deny
	}
	if admin.RegisterGatewayAccountLimitsRoutes(router.Group(""), limitsReader, authorizeLimitsHTTP) != nil {
		return deny
	}
	var private atomic.Pointer[gatewaytransport.Handler]
	native := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if cfg.CLI && strings.HasPrefix(r.URL.Path, "/private/native/v1/transports") {
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
		if cfg.CLI && r.Method == "GET" && r.URL.Path == "/inference-stats" {
			_ = json.NewEncoder(w).Encode(map[string]int64{"entries": inferenceEntries.Load()})
			return
		}
		if r.Method == "POST" && (r.URL.Path == "/limits/seed" || r.URL.Path == "/limits/tombstone") {
			var in service.GatewayAccountLimitsInput
			if json.NewDecoder(io.LimitReader(r.Body, 1025)).Decode(&in) != nil {
				w.WriteHeader(400)
				return
			}
			ctx, err := service.WithGatewayNativeConsumer(r.Context(), cfg.Consumer)
			if err == nil {
				ctx, err = service.WithGatewayNativeOAuthOwner(ctx, in.OwnerRef)
			}
			if err != nil {
				w.WriteHeader(403)
				return
			}
			route, authErr := authorizeLimits(ctx, in)
			if authErr != nil {
				w.WriteHeader(403)
				return
			}
			if r.URL.Path == "/limits/tombstone" {
				_, err = db.ExecContext(ctx, `UPDATE accounts SET deleted_at=clock_timestamp() WHERE id=$1 AND created_at=$2`, route.AccountID, route.CreatedAt)
			} else {
				physical := service.GatewayNativeOAuthPhysical{Route: route, Scope: service.GatewayNativeCredentialScope{Consumer: cfg.Consumer, Owner: in.OwnerRef, Account: in.AccountRef, Generation: route.Generation, Purpose: service.GatewayOAuthBundlePurpose}}
				err = db.QueryRowContext(ctx, `SELECT issuer,subject,provider_account_id,operation_ref FROM gateway_oauth_profile_qualifications WHERE account_id=$1 AND native_created_at=$2 AND generation=$3`, route.AccountID, route.CreatedAt, route.Generation).Scan(&physical.Issuer, &physical.Subject, &physical.ProviderAccount, &physical.Operation)
				observed := time.Date(2026, 10, 1, 1, 2, 3, 123456000, time.UTC)
				if err == nil {
					err = accountRepo.(service.GatewayAccountLimitsRepository).StoreGatewayAccountLimits(ctx, physical, service.CaptureGatewayCodexLimits(http.Header{"X-Codex-Primary-Used-Percent": {"37.5"}, "X-Codex-Primary-Window-Minutes": {"300"}, "X-Codex-Primary-Reset-After-Seconds": {"0"}}, observed), observed)
				}
			}
			if err != nil {
				w.WriteHeader(409)
				return
			}
			w.WriteHeader(204)
			return
		}
		if r.Method == "POST" && r.URL.Path == "/authorize" {
			authorized.Store(true)
		} else if r.Method != "GET" || r.URL.Path != "/stats" {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(counters{starts.Load(), polls.Load(), exchanges.Load(), checks.Load(), unexpected.Load()})
	}))
	defer controller.Close()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "ready", "nativeOrigin": native.URL, "controllerOrigin": controller.URL})
	scan := bufio.NewScanner(io.LimitReader(os.Stdin, 4096))
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
	callbackURL, err := url.Parse(command.CallbackOrigin)
	if err != nil || callbackURL.Scheme != "http" || callbackURL.Hostname() != "127.0.0.1" || callbackURL.Port() == "" || callbackURL.Path != "" {
		return deny
	}
	callback.Store(command.CallbackOrigin)
	configured := map[string]string{"event": "configured"}
	if cfg.CLI {
		post := func(ctx context.Context, path string, value any) error {
			body, err := json.Marshal(value)
			if err != nil || len(body) > 16384 {
				return deny
			}
			req, err := http.NewRequestWithContext(ctx, "POST", command.CallbackOrigin+"/private/native/v1/"+path, bytes.NewReader(body))
			if err != nil {
				return deny
			}
			req.Header.Set("Authorization", "Bearer "+cfg.Callback)
			req.Header.Set("Content-Type", "application/json")
			client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return deny }}
			response, err := client.Do(req)
			if err != nil {
				return deny
			}
			defer response.Body.Close()
			var reply struct {
				OK bool `json:"ok"`
			}
			if response.StatusCode != 200 || json.NewDecoder(io.LimitReader(response.Body, 16385)).Decode(&reply) != nil || !reply.OK {
				return deny
			}
			return nil
		}
		upstream, err := service.NewGatewayNativeLifetimeUpstream(fixtureHTTP{&http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return deny }}})
		if err != nil {
			return deny
		}
		gateway := service.NewOpenAIGatewayService(accountRepo, nil, nil, nil, nil, nil, nil, &config.Config{}, nil, nil, nil, nil, nil, upstream, nil, nil, nil, nil, nil, nil, nil, nil)
		primary := gatewaytransport.QualifiedProfile{Profile: service.GatewayMiMoResponsesProfile, Model: "fixture-unused", BaseURL: "https://api.openai.com/v1", QualificationRef: command.QualificationRef, RequestBytes: 1 << 20, OutputBytes: 1 << 20, Tokens: 65536, ProviderTokenUpperBound: 65536}
		qualified := gatewaytransport.QualifiedProfile{Profile: service.GatewayCodexOAuthResponsesProfile, Model: service.GatewayCodexOAuthModel, BaseURL: service.GatewayCodexOAuthBaseURL, QualificationRef: "controlled-source-v1", RequestBytes: 1 << 20, OutputBytes: 1 << 20, Tokens: 65536, ProviderTokenUpperBound: 65536}
		handler, err := gatewaytransport.New(context.Background(), gatewaytransport.Config{Gateway: gateway, Custody: custody, OAuth: dispatch, Codex: &qualified, Profile: primary,
			Enrollment:     gatewaytransport.Enrollment{OriginRef: command.OriginRef, EngineIncarnation: command.EngineIncarnation, QualificationRef: command.QualificationRef},
			CallbackOrigin: command.CallbackOrigin, CallbackCredential: cfg.Callback, CallbackTimeout: 4 * time.Second, IOTimeout: 15 * time.Second, ProviderReadIdle: 15 * time.Second, CleanupTimeout: 4 * time.Second, MaxEntries: 8, EnvelopeBytes: 2 << 20, CallbackBytes: 65536,
			Authorize: func(r *http.Request) (gatewaytransport.Peer, error) {
				switch r.Header.Get("Authorization") {
				case "Bearer " + cfg.Execution:
					return gatewaytransport.Peer{ConsumerID: cfg.Consumer, Role: "execution"}, nil
				case "Bearer " + cfg.Cleanup:
					return gatewaytransport.Peer{ConsumerID: cfg.Consumer, Role: "cleanup"}, nil
				}
				return gatewaytransport.Peer{}, deny
			},
			VerifyEnrollment: func(ctx context.Context, e gatewaytransport.Enrollment) error {
				return post(ctx, "enrollment", map[string]string{"originRef": e.OriginRef, "engineIncarnation": e.EngineIncarnation, "qualificationRef": e.QualificationRef})
			},
			VerifyDispatch: func(ctx context.Context, consumer string, p gatewaytransport.Proof, lease time.Time) error {
				return post(ctx, "dispatch-proof", map[string]any{"consumerId": consumer, "proof": p, "leaseExpiresAt": lease.UTC().Format(time.RFC3339Nano)})
			},
			AuthorizeCleanup: func(ctx context.Context, consumer string, p gatewaytransport.Proof, l gatewaytransport.CleanupLease) error {
				return post(ctx, "cleanup-authority", map[string]any{"consumerId": consumer, "proof": p, "cleanup": l})
			},
			AcknowledgeClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof, l gatewaytransport.CleanupLease, r gatewaytransport.Receipt) error {
				return post(ctx, "closure-ack", map[string]any{"consumerId": consumer, "proof": p, "cleanup": l, "receipt": r})
			},
			AuthorizeOwnerClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof) error {
				return post(ctx, "owner-closure-authority", map[string]any{"consumerId": consumer, "proof": p})
			},
			AcknowledgeOwnerClosure: func(ctx context.Context, consumer string, p gatewaytransport.Proof, r gatewaytransport.Receipt) error {
				return post(ctx, "closure-ack", map[string]any{"consumerId": consumer, "proof": p, "receipt": r})
			},
		})
		if err != nil {
			return deny
		}
		private.Store(handler)
		defer func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = handler.Stop(ctx)
		}()
		public := httptest.NewServer(handler.PublicHandler(2))
		defer public.Close()
		configured["inferenceOrigin"] = public.URL
	}
	_ = json.NewEncoder(os.Stdout).Encode(configured)
	if !scan.Scan() || scan.Text() != "stop" {
		return deny
	}
	var material, credentials int
	if db.QueryRow(`SELECT count(*) FROM gateway_oauth_connect_intents WHERE material_envelope<>''`).Scan(&material) != nil || db.QueryRow(`SELECT count(*) FROM accounts WHERE credentials::text LIKE $1 OR credentials::text LIKE $2 OR credentials::text LIKE $3`, "%"+access+"%", "%"+refresh+"%", "%"+idToken+"%").Scan(&credentials) != nil || material != 0 || credentials != 0 {
		return deny
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"event": "closed", "counts": counters{starts.Load(), polls.Load(), exchanges.Load(), checks.Load(), unexpected.Load()}, "plaintextCredentials": credentials, "retainedDeviceMaterial": material})
	return nil
}

func codexCLISSE() string {
	item := map[string]any{"id": "msg_codex_fixture", "type": "message", "role": "assistant", "status": "completed", "content": []any{map[string]any{"type": "output_text", "text": "Controlled local fixture reply.", "annotations": []any{}}}}
	response := map[string]any{"id": "resp_codex_fixture", "object": "response", "created_at": 1792782000, "status": "completed", "model": service.GatewayCodexOAuthModel, "output": []any{item}, "usage": map[string]any{"input_tokens": 7, "output_tokens": 3, "total_tokens": 10, "input_tokens_details": map[string]int{"cached_tokens": 0}, "output_tokens_details": map[string]int{"reasoning_tokens": 0}}}
	events := []map[string]any{{"type": "response.created", "response": map[string]any{"id": "resp_codex_fixture", "status": "in_progress", "output": []any{}}}, {"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"id": "msg_codex_fixture", "type": "message", "role": "assistant", "status": "in_progress", "content": []any{}}}, {"type": "response.output_text.delta", "output_index": 0, "item_id": "msg_codex_fixture", "content_index": 0, "delta": "Controlled local fixture reply."}, {"type": "response.output_item.done", "output_index": 0, "item": item}, {"type": "response.completed", "response": response}}
	var out strings.Builder
	for _, event := range events {
		raw, _ := json.Marshal(event)
		out.WriteString("event: " + event["type"].(string) + "\ndata: " + string(raw) + "\n\n")
	}
	return out.String()
}
