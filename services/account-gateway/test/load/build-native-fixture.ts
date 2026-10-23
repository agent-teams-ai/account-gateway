// Build only the exact public native source and a disposable migration adapter.
// The adapter delegates all migration semantics to repository.ApplyMigrations.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const nativeSourceCommit = '2ca8d7bd5a7646416580eda397b7ec50c0e12055';
export const migrationAdapterSource = [
  "// Disposable local fixture provisioning only. Production migration authority is",
  "// repository.ApplyMigrations; this helper cannot serve gateway requests.",
  "package main",
  "",
  "import (",
  " \"context\"",
  " \"crypto/sha256\"",
  " \"database/sql\"",
  " \"encoding/hex\"",
  " \"encoding/json\"",
  " \"fmt\"",
  " \"io/fs\"",
  " \"net/url\"",
  " \"os\"",
  " \"regexp\"",
  " \"sort\"",
  " \"strings\"",
  " \"time\"",
  " _ \"github.com/lib/pq\"",
  " \"github.com/Wei-Shaw/sub2api/internal/repository\"",
  " \"github.com/Wei-Shaw/sub2api/migrations\"",
  ")",
  "",
  "type entry struct { Filename string `json:\"filename\"`; SHA256 string `json:\"sha256\"` }",
  "func run() error {",
  " if len(os.Args)!=2 { return fmt.Errorf(\"one disposable local DSN required\") }",
  " u,err:=url.Parse(os.Args[1]); if err!=nil || u.Scheme!=\"postgresql\" || u.Hostname()!=\"127.0.0.1\" || u.Port()==\"\" || u.User==nil || u.User.Username()!=\"postgres\" || u.RawQuery!=\"sslmode=disable\" || !regexp.MustCompile(`^/ag_load_native_[a-f0-9]{32}$`).MatchString(u.Path) { return fmt.Errorf(\"non-fixture DSN denied\") }",
  " if _,present:=u.User.Password();present { return fmt.Errorf(\"password DSN denied\") }",
  " db,err:=sql.Open(\"postgres\",u.String());if err!=nil{return fmt.Errorf(\"fixture database open failed\")};defer db.Close()",
  " ctx,cancel:=context.WithTimeout(context.Background(),180*time.Second);defer cancel()",
  " var version string;var count int",
  " if db.QueryRowContext(ctx,\"SHOW server_version\").Scan(&version)!=nil || !strings.HasPrefix(version,\"17.10\") { return fmt.Errorf(\"PostgreSQL17.10 required\") }",
  " if db.QueryRowContext(ctx,\"SELECT count(*) FROM information_schema.tables WHERE table_schema='public'\").Scan(&count)!=nil || count!=0 { return fmt.Errorf(\"empty disposable native database required\") }",
  " if err=repository.ApplyMigrations(ctx,db);err!=nil{return fmt.Errorf(\"production migrations failed: %w\",err)}",
  " if db.QueryRowContext(ctx,\"SELECT count(*) FROM accounts\").Scan(&count)!=nil || count!=0 { return fmt.Errorf(\"empty accounts after migration required\") }",
  " names,err:=fs.Glob(migrations.FS,\"*.sql\");if err!=nil{return err};sort.Strings(names)",
  " sum:=sha256.New();entries:=make([]entry,0,len(names))",
  " for _,name:=range names {",
  "  data,e:=migrations.FS.ReadFile(name);if e!=nil{return e};h:=sha256.Sum256(data);digest:=hex.EncodeToString(h[:]);entries=append(entries,entry{name,digest});fmt.Fprintf(sum,\"%s\\x00%s\\n\",name,digest)",
  "  normalized:=sha256.Sum256([]byte(strings.TrimSpace(string(data))))",
  "  var applied string;if db.QueryRowContext(ctx,\"SELECT checksum FROM schema_migrations WHERE filename=$1\",name).Scan(&applied)!=nil || applied!=hex.EncodeToString(normalized[:]) { return fmt.Errorf(\"applied migration checksum mismatch\") }",
  " }",
  " return json.NewEncoder(os.Stdout).Encode(map[string]any{\"kind\":\"production-native-migration-receipt-v1\",\"sourceCommit\":\"2ca8d7bd5a7646416580eda397b7ec50c0e12055\",\"postgresVersion\":version,\"accounts\":count,\"migrationCount\":len(entries),\"migrationsSha256\":hex.EncodeToString(sum.Sum(nil)),\"migrations\":entries})",
  "}",
  "func main(){if err:=run();err!=nil{fmt.Fprintln(os.Stderr,err);os.Exit(1)}}",
].join('\n') + '\n';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw new Error('fixture-build:' + code); }
function run(executable: string, args: string[], cwd: string, env = process.env): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 1_048_576 });
  check(!result.error && result.status === 0, 'command-failed-' + args[0].replace(/[^a-z0-9-]/gi, ''));
  return result.stdout.trim();
}
function main() {
  const options = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    check(['--native-source','--output','--go'].includes(key) && value && !options.has(key), 'arguments'); options.set(key, value);
  }
  const source = options.get('--native-source'), output = options.get('--output'), go = options.get('--go') ?? 'go';
  check(source && output && isAbsolute(source) && isAbsolute(output), 'absolute-source-and-output-required');
  check(process.platform === 'linux', 'linux-required');
  check(run('git', ['rev-parse','HEAD'], source) === nativeSourceCommit, 'native-source-pin');
  check(run('git', ['status','--porcelain','--untracked-files=all'], source) === '', 'clean-native-source-required');
  check(run(go, ['version'], source).startsWith('go version go1.27.3 '), 'go-1-27-3-required');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const receiptPath = join(output, 'build-receipt.json');
  check(!existsSync(receiptPath), 'fresh-output-required');
  const backend = join(source, 'backend'), relative = 'cmd/ag_load_fixture_' + randomUUID().replaceAll('-', '');
  const generated = join(backend, relative);
  const env = { ...process.env, CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64', GOTOOLCHAIN: 'local' };
  const flags = ['-mod=readonly','-trimpath','-ldflags=-s -w'];
  const executable = join(output, 'account-gateway-native'), migrator = join(output, 'native-fixture-migrate');
  try {
    // Build the production CLI before introducing the disposable adapter, so
    // its embedded VCS metadata records the verified clean pinned checkout.
    run(go, ['build', ...flags, '-o', executable, './cmd/account-gateway'], backend, env);
    mkdirSync(generated, { mode: 0o700 }); writeFileSync(join(generated, 'main.go'), migrationAdapterSource, { mode: 0o600, flag: 'wx' });
    run(go, ['build', ...flags, '-o', migrator, './' + relative], backend, env);
    const receipt = { kind: 'native-fullstack-build-v1', sourceCommit: nativeSourceCommit, executable, sha256: digest(executable),
      migrator, migratorSha256: digest(migrator), migrationAdapterSha256: createHash('sha256').update(migrationAdapterSource).digest('hex'),
      goVersion: 'go1.27.3', flags, target: './cmd/account-gateway', CGO_ENABLED: '0', GOOS: 'linux', GOARCH: 'amd64' };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    process.stdout.write(JSON.stringify({ kind: receipt.kind, sourceCommit: nativeSourceCommit, receipt: receiptPath, sha256: receipt.sha256 }) + '\n');
  } finally { rmSync(generated, { recursive: true, force: true }); }
  check(run('git', ['status','--porcelain','--untracked-files=all'], source) === '', 'native-source-changed');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write((error instanceof Error && /^fixture-build:[a-z0-9-]+$/.test(error.message) ? error.message : 'fixture-build:failed') + '\n');
    process.exitCode = 1;
  }
}
