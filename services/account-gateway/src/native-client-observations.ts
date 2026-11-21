import * as c from "@agent-teams/account-gateway/contracts";
import { NativeControlHTTP, type NativeManagementOptions } from "./native-client-transport.ts";
import { NativeFailure, decode } from "./native-client-wire.ts";

export class NativeAccountModelsV2Client extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 5000, bodyBytes: 2_097_152 });
  }
  async readAccountModels(input: c.AccountModelsRequest): Promise<c.AccountModelsV2> {
    try {
      return c.accountModelsV2.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v2/account-models/read",
            c.accountModelsRequest.parse(input),
          ),
          8,
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
export class NativeAccountLimitsV3Client extends NativeControlHTTP {
  constructor(options: NativeManagementOptions) {
    super({ ...options, deadlineMs: 3000, bodyBytes: 262_144 });
  }
  async getAccountLimitsCapabilities(): Promise<c.AccountLimitsV3Capabilities> {
    try {
      return c.accountLimitsV3Capabilities.parse(
        decode(await this.call("GET", "/private/native/v3/account-limits/capabilities")),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
  async readAccountLimits(input: c.AccountLimitsRequest): Promise<c.AccountLimitsV3> {
    try {
      return c.accountLimitsV3.parse(
        decode(
          await this.call(
            "POST",
            "/private/native/v3/account-limits/read",
            c.accountLimitsRequest.parse(input),
          ),
          6,
        ),
      );
    } catch {
      throw new NativeFailure("invalid_readback");
    }
  }
}
