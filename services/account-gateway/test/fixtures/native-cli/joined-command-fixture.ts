// Disposable child for stream custody tests; never invokes a client or provider.
const mode = process.argv[2];
if (mode === "overflow") {
  process.stdout.write(Buffer.alloc(2_097_152, 120));
  process.stderr.write(Buffer.alloc(3_145_728, 121));
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(process.argv[4] ?? "");
  process.stdout.write(process.argv[3] ?? "");
  process.exitCode = mode === "failure" ? 1 : 0;
}
