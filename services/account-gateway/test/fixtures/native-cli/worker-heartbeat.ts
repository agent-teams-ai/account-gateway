/** Own the disposable driver's worker lease while real clients are running. */
export function startWorkerHeartbeat(heartbeat: () => Promise<void>) {
  let stopped = false;
  let busy = false;
  let failed = false;
  let inFlight = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || busy || failed) {
      return;
    }
    busy = true;
    inFlight = (async () => {
      try {
        await heartbeat();
      } catch {
        failed = true;
        clearInterval(timer);
      } finally {
        busy = false;
      }
    })();
  }, 5000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
    if (failed) {
      throw new Error("provider-worker-heartbeat-failed");
    }
  };
}
