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
} from "@agent-teams/account-gateway/contracts";
import { NativeControlHTTP, type NativeManagementOptions } from "./native-client-transport.ts";
import { NativeFailure, decode } from "./native-client-wire.ts";

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
