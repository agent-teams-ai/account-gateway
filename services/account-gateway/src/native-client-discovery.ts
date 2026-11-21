import { acceptedNativeAdmission, type NativeAccountAdmission } from "./native-admission-wire.ts";
import type {
  AccountModelsRequest,
  AccountModels,
  AccountLimitsRequest,
  AccountLimitsCapabilities,
  AccountLimits,
  AccountLimitsV2,
  AccountLimitsV2Capabilities,
  AccountLimitsRefreshCapabilities,
  ProviderConnectionCapabilitiesV2,
} from "@agent-teams/account-gateway/contracts";
import {
  accountModelsRequest,
  accountModels,
  accountLimitsRequest,
  accountLimitsRefreshCapabilities,
  accountLimitsCapabilities,
  accountLimits,
  accountLimitsV2,
  accountLimitsV2Capabilities,
  accountInfo,
  accountInfoV2,
  accountInfoFromV1,
  reference,
  providerConnectionCapabilitiesV2,
  PROVIDER_CONNECTIONS_V2_CONTRACT,
} from "@agent-teams/account-gateway/contracts";
import { NativeControlHTTP, type NativeManagementOptions } from "./native-client-transport.ts";
import { NativeFailure, decode, object } from "./native-client-wire.ts";
import type { AccountInfoObservation, AccountInfoSource } from "./account-info-port.ts";

export class NativeAccountCapabilitiesClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 2000, bodyBytes: 262144 });
  }
  async getProviderConnectionCapabilities(): Promise<ProviderConnectionCapabilitiesV2> {
    try {
      const wire = object(
        decode(await this.call("GET", "/private/native/v1/account-capabilities"), 10),
        ["contract", "profiles"],
      );
      if (wire.contract !== "native-account-capabilities/v1") {
        throw new NativeFailure("invalid_readback");
      }
      return providerConnectionCapabilitiesV2.parse({
        contract: PROVIDER_CONNECTIONS_V2_CONTRACT,
        capabilities: wire.profiles,
      });
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Native proof is checked and removed here; no administrative DTO leaves the adapter. */
export class NativeAccountInfoClient extends NativeControlHTTP implements AccountInfoSource {
  readonly #contract: "account-info/v1" | "account-info/v2";
  constructor(
    options: NativeManagementOptions,
    contract: "account-info/v1" | "account-info/v2" = "account-info/v2",
  ) {
    super({ ...options, deadlineMs: 2000, bodyBytes: 16 * 1024 });
    this.#contract = contract;
  }
  async readAccountInfo(
    input: AccountLimitsRequest,
    options: { readonly signal: AbortSignal; readonly deadlineMs: number },
  ): Promise<AccountInfoObservation> {
    try {
      const wire = object(
        decode(
          await this.call(
            "POST",
            this.#contract === "account-info/v1"
              ? "/private/native/v1/account-info/read"
              : "/private/native/v2/account-info/read",
            accountLimitsRequest.parse(input),
            options.deadlineMs,
            options.signal,
          ),
          8,
        ),
        ["info"],
        ["physicalGeneration", "principalVersion"],
      );
      const info =
        this.#contract === "account-info/v1"
          ? accountInfoFromV1(accountInfo.parse(wire.info))
          : accountInfoV2.parse(wire.info);
      if (info.status === "available") {
        const generation = reference.parse(wire.physicalGeneration);
        if (
          typeof wire.principalVersion !== "string" ||
          !/^[\x21-\x7e]{1,128}$/.test(wire.principalVersion)
        ) {
          throw new NativeFailure("invalid_readback");
        }
        return { info, generation };
      }
      if (wire.physicalGeneration !== undefined || wire.principalVersion !== undefined) {
        throw new NativeFailure("invalid_readback");
      }
      return { info };
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Cached source reads only; transport never retries or calls a provider. */
export class NativeAccountLimitsClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 3000, bodyBytes: 262144 });
  }
  async getAccountLimitsCapabilities(): Promise<AccountLimitsCapabilities> {
    try {
      return accountLimitsCapabilities.parse(
        decode(await this.call("GET", "/private/native/v1/account-limits/capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async readAccountAdmission(
    input: AccountLimitsRequest,
    deadlineMs?: number,
  ): Promise<NativeAccountAdmission> {
    try {
      const result = acceptedNativeAdmission(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-admission/read",
            accountLimitsRequest.parse(input),
            deadlineMs,
          ),
        ),
      );
      if (!result) {
        throw new NativeFailure("invalid_readback");
      }
      return result;
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  // A caller deadline can only shorten the fixed control deadline.
  async readAccountLimits(
    input: AccountLimitsRequest,
    deadlineMs?: number,
  ): Promise<AccountLimits> {
    try {
      return accountLimits.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-limits/read",
            accountLimitsRequest.parse(input),
            deadlineMs,
          ),
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Native alone performs custody-bound provider quota metadata refresh. */
export class NativeAccountLimitsRefreshClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 7000, bodyBytes: 262144 });
  }
  async getAccountLimitsRefreshCapabilities(): Promise<AccountLimitsRefreshCapabilities> {
    try {
      return accountLimitsRefreshCapabilities.parse(
        decode(await this.call("GET", "/private/native/v1/account-limits/refresh-capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async refreshAccountLimits(input: AccountLimitsRequest): Promise<AccountLimits> {
    try {
      return accountLimits.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-limits/refresh",
            accountLimitsRequest.parse(input),
          ),
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** v2 is selected by declared capability and is never probed alongside v1. */
export class NativeAccountLimitsV2Client extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 3000, bodyBytes: 262144 });
  }
  async getAccountLimitsCapabilities(): Promise<AccountLimitsV2Capabilities> {
    try {
      return accountLimitsV2Capabilities.parse(
        decode(await this.call("GET", "/private/native/v2/account-limits/capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async readAccountLimits(input: AccountLimitsRequest): Promise<AccountLimitsV2> {
    try {
      return accountLimitsV2.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v2/account-limits/read",
            accountLimitsRequest.parse(input),
          ),
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}

/** Bounded native catalogue read; no provider credentials cross this boundary. */
export class NativeAccountModelsClient extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 5000, bodyBytes: 2 * 1024 * 1024 });
  }
  async readAccountModels(input: AccountModelsRequest): Promise<AccountModels> {
    try {
      return accountModels.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v1/account-models/read",
            accountModelsRequest.parse(input),
          ),
          6,
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
