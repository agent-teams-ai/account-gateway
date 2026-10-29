//go:build linux

// Test-only executable. Copy into the actual native module's cmd directory;
// never substitute this helper for production gatewaybootstrap internals.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/gatewaybootstrap"
	"github.com/Wei-Shaw/sub2api/internal/gatewaylauncher"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	_ "github.com/lib/pq"
)

const image = "/opt/account-gateway-assembly/gateway-assembly-fixture"
const trust = "/opt/account-gateway-assembly/tls/ca.pem"
const consumer = "native-assembly-consumer"
const originRef = "native-assembly-origin"
const qualification = "controlled-native-assembly-v1"

var denied = errors.New("assembly fixture denied")
var rootName = regexp.MustCompile(`^/root/native_bootstrap_assembly_[a-f0-9]{32}$`)
var databaseName = regexp.MustCompile(`^native_bootstrap_assembly_[a-z0-9_]{1,32}$`)
var token = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// Emit a deliberately small projection of the ACTUAL returned launcher binding.
// uint64 process/lock facts use decimal strings to avoid JS precision loss.
type binding struct {
	OriginRef string `json:"originRef"`
	BootID string `json:"bootId"`
	Incarnation string `json:"incarnation"`
	PID int `json:"pid"`
	BirthTicks string `json:"birthTicks"`
	LockDevice string `json:"lockDevice"`
	LockInode string `json:"lockInode"`
}

func safeBinding(b gatewaylauncher.Binding) binding {
	return binding{b.OriginRef, b.BootID, b.Incarnation, b.PID,
		strconv.FormatUint(b.BirthTicks, 10), strconv.FormatUint(b.LockDevice, 10), strconv.FormatUint(b.LockInode, 10)}
}

type retirement struct {
	Binding binding `json:"binding"`
	Scope string `json:"scope"`
	Method string `json:"method"`
}

type message struct {
	Event string `json:"event"`
	Phase string `json:"phase,omitempty"`
	Binding *binding `json:"binding,omitempty"`
	Receipt *retirement `json:"receipt,omitempty"`
}

func emit(m message) error { return json.NewEncoder(os.Stdout).Encode(m) }

// Refuse symlinks and mutable/non-root ancestors before opening fixture files.
func protected(path string, directory bool) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path { return denied }
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	current := "/"
	for i := -1; i < len(parts); i++ {
		if i >= 0 { current = filepath.Join(current, parts[i]) }
		s, err := os.Lstat(current)
		if err != nil { return denied }
		st, ok := s.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || s.Mode()&os.ModeSymlink != 0 || s.Mode().Perm()&0022 != 0 { return denied }
		if i < len(parts)-1 || directory {
			if !s.IsDir() { return denied }
		} else if !s.Mode().IsRegular() || st.Nlink != 1 { return denied }
	}
	return nil
}

func endpoint(raw, scheme, path string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != scheme || u.Hostname() != "127.0.0.1" || u.Port() == "" ||
		u.Path != path || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.RawPath != "" { return false }
	_, err = net.ResolveTCPAddr("tcp4", u.Host)
	return err == nil
}

func fixtureConfig(root string) (*os.File, gatewaybootstrap.Config, error) {
	var c gatewaybootstrap.Config
	if os.Geteuid() != 0 || runtime.Version() != "go1.27.3" || !rootName.MatchString(root) || protected(root, true) != nil ||
		protected(image, false) != nil || protected(trust, false) != nil { return nil, c, denied }
	path := filepath.Join(root, "bootstrap.json")
	if protected(path, false) != nil { return nil, c, denied }
	f, err := os.Open(path)
	if err != nil { return nil, c, denied }
	s, err := f.Stat()
	if err != nil || s.Mode().Perm() != 0600 || s.Size() < 1 || s.Size() > 65536 { _ = f.Close(); return nil, c, denied }
	data, err := io.ReadAll(io.NewSectionReader(f, 0, 65537))
	if err != nil || json.Unmarshal(data, &c) != nil { _ = f.Close(); return nil, c, denied }
	u, err := url.Parse(c.PostgresDSN)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host != "127.0.0.1:5432" ||
		u.User == nil || u.User.Username() != "postgres" || !databaseName.MatchString(strings.TrimPrefix(u.Path, "/")) ||
		u.RawPath != "" || u.Fragment != "" || u.RawQuery != "sslmode=disable" { _ = f.Close(); return nil, c, denied }
	if _, has := u.User.Password(); has { _ = f.Close(); return nil, c, denied }
	if !endpoint("http://"+c.ListenAddress, "http", "") || !endpoint(c.Authority.Origin, "http", "") ||
		!endpoint(c.Profile.BaseURL, "https", "/v1") || !token.MatchString(c.Authority.Credential) ||
		c.Profile.Model != "mimo-test" || c.Profile.QualificationRef != qualification || c.Profile.RequestBytes != 4096 ||
		c.Profile.OutputBytes != 65536 || c.Profile.Tokens != 32 || c.Profile.ProviderTokenUpperBound != 100 || c.MaxEntries != 4 ||
		c.Custody.ActiveKeyID != "assembly" || len(c.Custody.Keys) != 1 || c.Custody.Keys[0].ID != "assembly" || len(c.Peers) != 3 {
		_ = f.Close(); return nil, c, denied
	}
	seen := map[string]bool{c.Authority.Credential: true}
	for i, role := range []string{"management", "execution", "cleanup"} {
		p := c.Peers[i]
		if p.ConsumerID != consumer || p.Role != role || !token.MatchString(p.Credential) || seen[p.Credential] {
			_ = f.Close(); return nil, c, denied
		}
		seen[p.Credential] = true
	}
	return f, c, nil
}

func migrate(dsn string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db, err := sql.Open("postgres", dsn)
	if err != nil { return denied }
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(2)
	u, _ := url.Parse(dsn)
	var name, version string
	var empty bool
	if db.QueryRowContext(ctx, `SELECT current_database(), current_setting('server_version'),
		NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace)
		AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace)
		AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace)`).Scan(&name, &version, &empty) != nil ||
		name != strings.TrimPrefix(u.Path, "/") || (version != "17.10" && !strings.HasPrefix(version, "17.10 ")) || !empty { return denied }
	// Complete actual embedded migration set, including native 241/242. No Ent DDL.
	if repository.ApplyMigrations(ctx, db) != nil { return denied }
	return nil
}

func runParent(root string) (phase string, err error) {
	f, c, err := fixtureConfig(root)
	if err != nil { return "guard", denied }
	defer func() { _ = f.Close() }()
	if migrate(c.PostgresDSN) != nil { return "migrations", denied }
	if emit(message{Event: "migrated"}) != nil { return "output", denied }
	a := gatewaylauncher.AuthorityConfig{Directory: filepath.Join(root, "authority"), OriginRef: originRef}
	l, startErr := gatewaylauncher.Start(gatewaylauncher.Config{Authority: a, EnginePath: image, Args: []string{"engine"},
		Env: []string{"SSL_CERT_FILE="+trust, "SSL_CERT_DIR="+filepath.Dir(trust), "GIN_MODE=release"}, EngineUID: 65534, EngineGID: 65534, BootstrapFile: f})
	if l == nil { return "start", denied }
	// Keep the exact handle even on Start's post-exec failure; never restart.
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, e := l.Shutdown(ctx); e != nil { phase, err = "retirement", denied }
	}()
	if startErr != nil { return "start", denied }
	b := l.Binding()
	safe := safeBinding(b)
	if emit(message{Event: "binding", Binding: &safe}) != nil { return "output", denied }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = l.AwaitReady(ctx)
	cancel()
	if err != nil { return "readiness", denied }
	if emit(message{Event: "ready", Binding: &safe}) != nil { return "output", denied }
	// Bounded root-parent pulses allow two real requests to each use their own
	// five-second budget. They never change engine/claim/closure authority.
	command := make(chan string, 1)
	go func() {
		s := bufio.NewScanner(io.LimitReader(os.Stdin, 2048))
		s.Buffer(make([]byte, 128), 128)
		for s.Scan() {
			var c struct { Command string `json:"command"` }
			if json.Unmarshal(s.Bytes(), &c) != nil { command <- "invalid"; return }
			command <- c.Command
			if c.Command != "pulse" { return }
		}
		if s.Err() != nil { command <- "invalid" } else { command <- "stop" }
	}()
	commandWait:
	for remaining := 40; ; remaining-- {
		if remaining == 0 { return "command-limit", denied }
		select {
		case c := <-command:
			if c == "stop" { break commandWait }
			if c != "pulse" { return "command", denied }
		case <-time.After(5*time.Second):
			return "command-timeout", denied
		}
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	r, err := l.Shutdown(ctx)
	cancel()
	if err != nil { return "retirement", denied }
	read, err := gatewaylauncher.ReadReceipt(a, b)
	if err != nil || !reflect.DeepEqual(r, read) { return "retirement-readback", denied }
	safeReceipt := retirement{safeBinding(r.Binding), r.Scope, r.Method}
	if emit(message{Event: "retired", Binding: &safe, Receipt: &safeReceipt}) != nil { return "output", denied }
	return "", nil
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "engine" {
		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
		defer cancel()
		if gatewaybootstrap.Run(ctx, gatewaybootstrap.Options{}) != nil { os.Exit(72) }
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "parent" {
		if phase, err := runParent(os.Args[2]); err == nil { return } else { _ = emit(message{Event: "failed", Phase: phase}) }
	} else { _ = emit(message{Event: "failed", Phase: "arguments"}) }
	os.Exit(73)
}
