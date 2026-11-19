import * as c from "@agent-teams/account-gateway/contracts";
import { isDeepStrictEqual } from "node:util";
import { KernelError } from "./domain.ts";
import type { AccountInfoIdentity } from "./domain.ts";

/** Safe backend result. Private native principal proofs terminate in its adapter. */
export type AccountInfoObservation =
  | { readonly info: Extract<c.AccountInfo, { status: "available" }>; readonly generation: string }
  | { readonly info: Exclude<c.AccountInfo, { status: "available" }> };
export interface AccountInfoSource {
  readAccountInfo(
    input: c.AccountLimitsRequest,
    options: { readonly signal: AbortSignal; readonly deadlineMs: number },
  ): Promise<AccountInfoObservation>;
}
export interface AccountInfoAuthority {
  /** One bounded current observation, with caller/owner/profile authorization. */
  observe(input: c.AccountInfoReadRequest): Promise<readonly AccountInfoIdentity[]>;
}
function bounded<T>(work: Promise<T>, milliseconds: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      clean();
      reject(new KernelError("unavailable"));
    };
    const timer = setTimeout(abort, Math.max(0, milliseconds));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    void work.then(
      (value) => {
        clean();
        resolve(value);
        return value;
      },
      (error: unknown) => {
        clean();
        reject(error);
      },
    );
  });
}

/** Bounded read orchestration; no facts cache, provider I/O or account mutations. */
export class AccountInfoReader {
  readonly #source: AccountInfoSource | undefined;
  readonly #active = new Map<string, number>();
  constructor(source?: AccountInfoSource) {
    this.#source = source;
  }

  async read(
    authority: AccountInfoAuthority,
    input: c.AccountInfoReadRequest,
    options: { readonly consumerId: string; readonly signal: AbortSignal },
  ): Promise<c.AccountInfoReadResponse> {
    const captured = c.accountInfoReadRequest.parse(input);
    const started = Date.now(),
      deadline = started + 2500,
      sourceDeadline = started + 2000;
    const controller = new AbortController();
    const cancel = () => {
      controller.abort();
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) {
      cancel();
    }
    const sourceTimer = setTimeout(cancel, Math.max(0, sourceDeadline - Date.now()));
    const ownerKey = JSON.stringify([options.consumerId, captured.ownerRef]);
    try {
      const before = await bounded(
        authority.observe(captured),
        deadline - Date.now(),
        options.signal,
      );
      if (
        before.length !== captured.accountRefs.length ||
        before.some(
          (row, index) =>
            row.accountRef !== captured.accountRefs[index] || row.ownerRef !== captured.ownerRef,
        )
      ) {
        throw new KernelError("denied");
      }
      const infos: c.AccountInfo[] = before.map(() => ({
        status: this.#source ? "unavailable" : "unsupported",
      }));
      let next = 0;
      const worker = async () => {
        for (;;) {
          if (next >= before.length || controller.signal.aborted || !this.#source) {
            return;
          }
          const index = next++,
            row = before[index];
          if (!row.readable || row.generation === undefined) {
            continue;
          }
          if ((this.#active.get(ownerKey) ?? 0) >= 2) {
            return;
          }
          this.#active.set(ownerKey, (this.#active.get(ownerKey) ?? 0) + 1);
          const source = this.#source;
          const work = Promise.resolve()
            .then(() =>
              source.readAccountInfo(
                {
                  ownerRef: row.ownerRef,
                  accountRef: row.accountRef,
                  profileId: row.profile,
                  expectedAuthorizationEpoch: row.epoch,
                },
                { signal: controller.signal, deadlineMs: Math.max(1, sourceDeadline - Date.now()) },
              ),
            )
            .finally(() => {
              const active = (this.#active.get(ownerKey) ?? 1) - 1;
              if (active) {
                this.#active.set(ownerKey, active);
              } else {
                this.#active.delete(ownerKey);
              }
            });
          try {
            const observed = await bounded(work, sourceDeadline - Date.now(), controller.signal);
            const parsed = c.accountInfo.safeParse(observed.info);
            if (
              parsed.success &&
              (parsed.data.status !== "available" ||
                ("generation" in observed && observed.generation === row.generation))
            ) {
              infos[index] = parsed.data;
            }
          } catch {
            /* A missing observation never changes account lifecycle. */
          }
        }
      };
      await Promise.all([worker(), worker()]);
      // The complete batch is fenced after the slowest backend read, not per row.
      const after = await bounded(
        authority.observe(captured),
        deadline - Date.now(),
        options.signal,
      );
      if (!isDeepStrictEqual(before, after) || options.signal.aborted || Date.now() >= deadline) {
        throw new KernelError("denied");
      }
      return c.accountInfoReadResponse.parse({
        contract: c.ACCOUNT_INFO_CONTRACT,
        accounts: after.map((row, index) => ({
          accountRef: row.accountRef,
          metadataRevision: row.revision,
          authorizationEpoch: row.epoch,
          info: infos[index],
        })),
      });
    } finally {
      clearTimeout(sourceTimer);
      options.signal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}
