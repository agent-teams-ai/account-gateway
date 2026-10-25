import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { KernelError } from "./domain.ts";

// Candidate policy, not a memory-qualified capacity. One physical eight-client
// pool leaves two clients available to protected control and cleanup work.
export const serviceCapacity = Object.freeze({
  dataActive: 16,
  controlActive: 8,
  dataWaiting: 8,
  controlWaiting: 8,
  poolClients: 8,
  controlReserved: 2,
  timeoutMs: 5000,
});
export type ServiceLane = "data" | "control";
export type Checkout = () => Promise<PoolClient>;
export class ServiceCapacityError extends KernelError {
  constructor() {
    super("unavailable");
  }
}
const lane = new AsyncLocalStorage<ServiceLane>();
export const inServiceLane = <T>(selected: ServiceLane, work: () => T): T =>
  lane.run(selected, work);
export function facadeUsageReadRoute(
  method: string | undefined,
  path: string | undefined,
): boolean {
  if (method !== "GET" || !path) return false;
  const query = path.indexOf("?");
  if (query < 0) return /^\/v1\/usage(?:\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)?$/.test(path);
  if (path.slice(0, query) !== "/v1/usage" || path.length - query > 1600) return false;
  const seen = new Set<string>();
  return path
    .slice(query + 1)
    .split("&")
    .every((pair) => {
      const match = /^(limit|afterCursor|highWaterCursor)=([A-Za-z0-9_-]+)$/.exec(pair);
      if (!match || seen.has(match[1])) return false;
      seen.add(match[1]);
      return match[1] === "limit" ? /^[1-9][0-9]{0,2}$/.test(match[2]) : match[2].length <= 512;
    });
}
export function facadeBoundedReadRoute(
  method: string | undefined,
  path: string | undefined,
): boolean {
  return (
    facadeUsageReadRoute(method, path) ||
    (method === "POST" &&
      (path === "/v1/account-limits/read" || path === "/v2/account-limits/read" || path === "/v1/account-models/read"))
  );
}
export function facadeControlRoute(method: string | undefined, path: string | undefined): boolean {
  if (facadeUsageReadRoute(method, path)) return true;
  if (
    (method === "GET" &&
      (path === "/v1/capabilities/account-limits" ||
        path === "/v2/capabilities/account-limits" ||
        path === "/v1/provider-connection-capabilities")) ||
    (method === "POST" &&
      (path === "/v1/account-limits/read" || path === "/v2/account-limits/read" || path === "/v1/account-models/read"))
  )
    return true;
  if (!path || /[?#%\r\n]/.test(path)) return false;
  return (
    (method === "POST" &&
      (/^\/v1\/executions\/[A-Za-z0-9_-]+\/close$/.test(path) ||
        path === "/v1/policy-fences" ||
        /^\/v2\/accounts\/[A-Za-z0-9_-]+\/(suspend|resume)$/.test(path) ||
        /^\/v1\/accounts\/[A-Za-z0-9_-]+\/disable$/.test(path))) ||
    (method === "GET" &&
      (path === "/v2/capabilities/account-lifecycle" ||
        /^\/v2\/(operations|accounts)\/[A-Za-z0-9_-]+$/.test(path) ||
        path === "/v2/accounts" ||
        /^\/v1\/(operations|accounts)\/[A-Za-z0-9_-]+$/.test(path) ||
        /^\/v1\/accounts\/[A-Za-z0-9_-]+\/retirement\/[A-Za-z0-9_-]+$/.test(path) ||
        /^\/v1\/policy-fences\/[A-Za-z0-9_-]+\/closure$/.test(path) ||
        /^\/v1\/executions\/[A-Za-z0-9_-]+(?:\/requests\/[A-Za-z0-9_-]+)?$/.test(path)))
  );
}

export class ServiceAdmission {
  private active = { data: 0, control: 0 };
  private stopped = false;
  private idle: (() => void)[] = [];
  reserve(selected: ServiceLane): (() => void) | undefined {
    if (
      this.stopped ||
      this.active[selected] >= serviceCapacity[selected === "data" ? "dataActive" : "controlActive"]
    )
      return;
    this.active[selected]++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active[selected]--;
      if (!this.active.data && !this.active.control)
        this.idle.splice(0).forEach((resolve) => resolve());
    };
  }
  stop(): Promise<void> {
    this.stopped = true;
    return !this.active.data && !this.active.control
      ? Promise.resolve()
      : new Promise((resolve) => this.idle.push(resolve));
  }
}

// A WeakMap prevents independent adapter gates for the same physical pool.
const owners = new WeakMap<Pool, Checkout>();
export function sharedCheckout(pool: Pool): Checkout {
  const existing = owners.get(pool);
  if (existing) return existing;
  let occupied = 0,
    dataOccupied = 0;
  type Waiter = { start(): void };
  const waiting: Record<ServiceLane, Waiter[]> = { data: [], control: [] };
  const available = (selected: ServiceLane) =>
    occupied < serviceCapacity.poolClients &&
    (selected === "control" ||
      dataOccupied < serviceCapacity.poolClients - serviceCapacity.controlReserved);
  const pump = () => {
    for (const selected of ["control", "data"] as const)
      while (waiting[selected].length && available(selected)) waiting[selected].shift()!.start();
  };
  const checkout: Checkout = () => {
    const selected = lane.getStore() ?? "data";
    return new Promise<PoolClient>((resolve, reject) => {
      let started = false,
        settled = false,
        disposed = false;
      const deny = (error: KernelError = new ServiceCapacityError()) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        occupied--;
        if (selected === "data") dataOccupied--;
        pump();
      };
      const timer = setTimeout(() => {
        deny();
        if (!started) {
          const index = waiting[selected].indexOf(waiter);
          if (index >= 0) waiting[selected].splice(index, 1);
        }
        // In-flight connect still owns its physical slot until it settles.
      }, serviceCapacity.timeoutMs);
      const waiter: Waiter = {
        start() {
          started = true;
          occupied++;
          if (selected === "data") dataOccupied++;
          let acquisition: Promise<PoolClient>;
          try {
            acquisition = pool.connect();
          } catch {
            clearTimeout(timer);
            deny(new KernelError("unavailable"));
            dispose();
            return;
          }
          void acquisition
            .then(
              (client) => {
                clearTimeout(timer);
                if (settled) {
                  try {
                    client.release();
                  } finally {
                    dispose();
                  }
                  return;
                }
                const release = client.release.bind(client);
                let released = false;
                client.release = (error?: Error | boolean) => {
                  if (released) return;
                  released = true;
                  try {
                    release(error);
                  } finally {
                    dispose();
                  }
                };
                settled = true;
                resolve(client);
              },
              () => {
                clearTimeout(timer);
                deny(new KernelError("unavailable"));
                dispose();
              },
            )
            .catch(() => undefined);
        },
      };
      if (available(selected)) waiter.start();
      else if (
        waiting[selected].length <
        serviceCapacity[selected === "data" ? "dataWaiting" : "controlWaiting"]
      )
        waiting[selected].push(waiter);
      else {
        clearTimeout(timer);
        deny();
      }
    });
  };
  owners.set(pool, checkout);
  return checkout;
}
