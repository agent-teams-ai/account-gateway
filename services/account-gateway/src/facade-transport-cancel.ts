import { KernelError } from "./domain.ts";
import type { TrustedContext, NativeDispatchProof, CleanupAuthority } from "./domain.ts";
import { captureContext } from "./management.ts";
import type { FacadeOptions } from "./facade.ts";

// Cleanup is a separate exact leased authority. A successful outbound cancel
// does not certify provider transport closure or release SQL occupancy.
export async function cancelFacadeTransport(
  options: FacadeOptions,
  context: TrustedContext,
  input: NativeDispatchProof,
  authority: CleanupAuthority,
): Promise<void> {
  const ctx = captureContext(context),
    proof = {
      executionRef: input.executionRef,
      requestRef: input.requestRef,
      worker: input.worker,
      token: input.token,
      native: {
        originRef: input.native.originRef,
        engineIncarnation: input.native.engineIncarnation,
        requestNonce: input.native.requestNonce,
        generation: input.native.generation,
      },
    },
    cleanup = { cleanupRef: authority.cleanupRef, token: authority.token };
  const configured = options.enrollment,
    transport = options.transport,
    kernel = options.kernel;
  if (!configured || !transport?.cancel) {
    throw new KernelError("unavailable");
  }
  const peer = {
    originRef: configured.originRef,
    engineIncarnation: configured.engineIncarnation,
    worker: configured.worker,
  };
  if (
    proof.native.originRef !== peer.originRef ||
    proof.native.engineIncarnation !== peer.engineIncarnation
  ) {
    throw new KernelError("denied");
  }
  const transports = await kernel.cleanupTransports(
    ctx,
    cleanup.cleanupRef,
    peer.worker,
    cleanup.token,
  );
  if (
    !transports.some(
      (p) =>
        p.executionRef === proof.executionRef &&
        p.requestRef === proof.requestRef &&
        p.worker === proof.worker &&
        p.token === proof.token &&
        p.native?.originRef === proof.native.originRef &&
        p.native.engineIncarnation === proof.native.engineIncarnation &&
        p.native.requestNonce === proof.native.requestNonce &&
        p.native.generation === proof.native.generation,
    )
  ) {
    throw new KernelError("denied");
  }
  await transport.cancel(ctx, proof, cleanup);
}

