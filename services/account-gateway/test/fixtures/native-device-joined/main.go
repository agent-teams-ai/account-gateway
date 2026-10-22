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

	"github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/openai"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	_ "github.com/lib/pq"
)

type configuration struct{ DSN, Consumer, Control, Callback string }
type counters struct {
	Starts     int64 `json:"starts"`
	Polls      int64 `json:"polls"`
	Exchanges  int64 `json:"exchanges"`
	Checks     int64 `json:"checks"`
	Unexpected int64 `json:"unexpected"`
}

var deny = errors.New("joined fixture refused")

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
	var starts, polls, exchanges, checks, unexpected atomic.Int64
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
		default:
			unexpected.Add(1)
			w.WriteHeader(404)
		}
	}))
	defer provider.Close()
	transport := provider.Client().Transport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
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
	native := httptest.NewServer(router)
	defer native.Close()
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+cfg.Control {
			w.WriteHeader(403)
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
		CallbackOrigin string `json:"callbackOrigin"`
	}
	if json.Unmarshal(scan.Bytes(), &command) != nil {
		return deny
	}
	callbackURL, err := url.Parse(command.CallbackOrigin)
	if err != nil || callbackURL.Scheme != "http" || callbackURL.Hostname() != "127.0.0.1" || callbackURL.Port() == "" || callbackURL.Path != "" {
		return deny
	}
	callback.Store(command.CallbackOrigin)
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "configured"})
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
