import { identifier, uuid } from "./domain.ts";
import type { RetainedCustodyProof } from "./domain.ts";
import { oauthProfileDefinition } from "./oauth-profiles.ts";
import { exactCandidate, physicalCandidate } from "./candidate-identity.ts";
import type {
  RetainedCustodyVerifier,
  CandidateJournal,
  CandidateMapping,
  CandidateNative,
  NativeReadback,
  PhysicalCandidate,
} from "./management.ts";
import { NativeControlHTTP } from "./native-client-transport.ts";
import {
  NativeFailure,
  candidatesPath,
  object,
  decode,
  readback,
  wireDescriptor,
  oauthEndpoint,
  oauthPhysicalOrAPI,
  samePhysical,
} from "./native-client-wire.ts";

export class NativeRetainedCustodyClient
  extends NativeControlHTTP
  implements RetainedCustodyVerifier
{
  async verify(input: CandidateMapping): Promise<RetainedCustodyProof> {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (!exactCandidate(input, d) || d.nativePhysicalIdentity !== d.generation) {
      throw new NativeFailure("denied");
    }
    const definition = oauthProfileDefinition(d.profile);
    const oauth = !!definition;
    if (oauth) {
      identifier(input.operationId);
    }
    const request = {
      contract: "native-retained-custody/v1",
      owner_ref: input.ownerRef,
      account_ref: input.accountRef,
      descriptor: wireDescriptor(d),
      ...(oauth ? { operation: input.operationId, generation: input.generation } : {}),
    };
    const bytes = await this.call(
      oauth ? "POST" : "GET",
      definition
        ? oauthEndpoint(definition, "custody")
        : candidatesPath + "/" + d.generation + "/custody",
      request,
    );
    try {
      const r = object(
        decode(bytes),
        ["contract", "generation", "native", "credential_kinds", "retention", "proof"],
        oauth ? ["oauth_policy"] : [],
      );
      const native = oauthPhysicalOrAPI(r.native);
      const retention = object(r.retention, ["state", "credential"]);
      const proof = object(r.proof, ["authenticated"]);
      const kinds = r.credential_kinds;
      if (
        r.contract !== "native-retained-custody/v1" ||
        r.generation !== d.generation ||
        !samePhysical(d, native) ||
        !Array.isArray(kinds) ||
        kinds.length !== 1 ||
        kinds[0] !== (oauth ? "oauth" : "api_key") ||
        retention.state !== (oauth ? "inactive" : "active") ||
        retention.credential !== "retained" ||
        proof.authenticated !== true
      ) {
        throw new NativeFailure("invalid_readback");
      }
      if (oauth) {
        const policy = object(r.oauth_policy, ["provider_validity", "expired_but_refreshable"]);
        if (
          retention.state !== "inactive" ||
          policy.provider_validity !== "unasserted" ||
          ![
            "not-qualified-by-existing-policy",
            "not-due-by-existing-policy",
            "eligible-by-existing-policy",
          ].includes(policy.expired_but_refreshable as string)
        ) {
          throw new NativeFailure("invalid_readback");
        }
      }
      return Object.freeze({
        contract: "native-retained-custody/v1",
        generation: d.generation,
        nativePhysicalIdentity: d.nativePhysicalIdentity,
        credentialKinds: Object.freeze([oauth ? ("oauth" as const) : ("api_key" as const)]),
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
export class NativeManagementClient extends NativeControlHTTP implements CandidateNative {
  async create(input: CandidateJournal, displayName: string, apiKey: string): Promise<void> {
    const scope = {
      consumerId: input.consumerId,
      generation: input.generation,
      accountRef: input.accountRef,
      ownerRef: input.ownerRef,
      profile: input.profile.profile,
    };
    this.scope(scope);
    uuid(scope.generation);
    uuid(scope.accountRef);
    identifier(scope.ownerRef);
    identifier(scope.profile, 64);
    if (
      typeof displayName !== "string" ||
      !displayName.isWellFormed() ||
      displayName.length < 1 ||
      displayName.length > 128 ||
      Buffer.byteLength(displayName) > 400 ||
      typeof apiKey !== "string" ||
      !apiKey.isWellFormed() ||
      Buffer.byteLength(apiKey) < 1 ||
      Buffer.byteLength(apiKey) > 4096 ||
      apiKey.trim() !== apiKey
    ) {
      throw new NativeFailure("bounded");
    }
    await this.call("POST", candidatesPath, {
      generation: scope.generation,
      profile: scope.profile,
      name: displayName,
      api_key: apiKey,
      owner_ref: scope.ownerRef,
      account_ref: scope.accountRef,
    });
  }
  async read(input: CandidateJournal): Promise<readonly NativeReadback[]> {
    this.scope(input);
    const generation = input.generation;
    const result = readback(await this.call("GET", candidatesPath + "/" + generation));
    if (!exactCandidate(input, result)) {
      throw new NativeFailure("invalid_readback");
    }
    return Object.freeze([result]);
  }
  private descriptor(input: CandidateMapping): PhysicalCandidate {
    this.scope(input);
    const d = physicalCandidate(input.descriptor);
    if (
      d.generation !== input.generation ||
      d.nativePhysicalIdentity !== input.generation ||
      d.profile !== input.profile.profile ||
      d.baseURL !== input.profile.baseURL ||
      d.model !== input.profile.model
    ) {
      throw new NativeFailure("denied");
    }
    return d;
  }
  async setState(input: CandidateMapping, state: "active" | "inactive"): Promise<void> {
    const d = this.descriptor(input);
    if (!["active", "inactive"].includes(state)) {
      throw new NativeFailure("denied");
    }
    // The PUT ACK itself does not authorize promotion; orchestration uses an exact GET.
    const response = readback(
      await this.call("PUT", candidatesPath + "/" + d.generation, {
        descriptor: wireDescriptor(d),
        state,
      }),
    );
    if (
      response.state !== state ||
      response.generation !== d.generation ||
      response.nativeId !== d.nativeId ||
      response.createdAt !== d.createdAt ||
      response.profile !== d.profile ||
      response.baseURL !== d.baseURL ||
      response.model !== d.model
    ) {
      throw new NativeFailure("invalid_readback");
    }
  }
  async erase(input: CandidateMapping): Promise<void> {
    const d = this.descriptor(input);
    const bytes = await this.call("POST", candidatesPath + "/" + d.generation + "/erase", {
      descriptor: wireDescriptor(d),
    });
    try {
      const ack = object(decode(bytes), ["state", "credentials_erased"]);
      if (ack.state !== "tombstoned" || ack.credentials_erased !== true) {
        throw new NativeFailure("invalid_readback");
      }
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

// The trusted outer composition binds a concrete consumer AND original owner.
// Completed custody remains pending until separate exact descriptor readback.
