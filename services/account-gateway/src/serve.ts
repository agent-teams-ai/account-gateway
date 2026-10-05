// Command-line arguments contain only the protected config pathname.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config-file') {
  process.stderr.write('config_denied\n'); process.exitCode = 2;
} else {
  const abort = new AbortController();
  const stop = () => abort.abort();
  let outputLost = false;
  const outputError = () => { outputLost = true; process.exitCode = 1; stop(); };
  // A lost operator reader must still reach exact-parent bounded shutdown.
  // Keep these listeners through the final asynchronous stream write.
  process.stdout.on('error', outputError); process.stderr.on('error', outputError);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    // Import failures also cross the safe diagnostic boundary.
    const { startService } = await import('./service.ts');
    const service = await startService(args[1], abort.signal);
    if (!outputLost) process.stdout.write('ready\n');
    const result = await service.stopped;
    if (!outputLost) process.stdout.write(result + '\n'); process.exitCode = result === 'retired' && !outputLost ? 0 : 1;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (!outputLost) process.stderr.write((typeof code === 'string' && ['config_denied','startup_denied','runtime_denied','shutdown_pending'].includes(code)
      ? code : 'startup_denied') + '\n'); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  // A pending protected parent is never force-killed. Exit the foreground Node
  // entry after its bounded handoff; Go retains its exact launcher evidence.
  if (process.exitCode) process.exit(process.exitCode);
}
