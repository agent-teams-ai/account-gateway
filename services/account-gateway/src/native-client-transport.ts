import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { KernelError, identifier, uuid } from "./domain.ts";
import type { CandidateJournal } from "./management.ts";
import type { NativeControlAdmission } from "./service-admission.ts";
import { NativeFailure } from "./native-client-wire.ts";

export interface NativeManagementOptions {
  readonly origin: string;
  readonly consumerId: string;
  readonly controlCredential: string;
  readonly deadlineMs?: number;
  readonly bodyBytes?: number;
  readonly headerBytes?: number;
  readonly admission?: NativeControlAdmission;
}
// One concrete bounded transport shared by the two private control adapters.
// It carries no enrollment policy and never performs a second HTTP attempt.
export class NativeControlHTTP {
  readonly #origin: URL;
  readonly #consumer: string;
  readonly #control: string;
  readonly #deadlineMs: number;
  readonly #bodyBytes: number;
  readonly #headerBytes: number;
  readonly #admission?: NativeControlAdmission;
  constructor(options: NativeManagementOptions) {
    let origin: URL;
    try {
      origin = new URL(options.origin);
    } catch {
      throw new KernelError("invalid");
    }
    if (
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname))
      ) ||
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash
    ) {
      throw new KernelError("invalid");
    }
    identifier(options.consumerId);
    if (
      typeof options.controlCredential !== "string" ||
      options.controlCredential.length < 1 ||
      options.controlCredential.length > 2048 ||
      !/^[A-Za-z0-9._~+/-]+=*$/.test(options.controlCredential)
    ) {
      throw new KernelError("invalid");
    }
    const deadlineMs = options.deadlineMs ?? 5000,
      bodyBytes = options.bodyBytes ?? 65_536,
      headerBytes = options.headerBytes ?? 16_384;
    if (
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 30_000 ||
      !Number.isInteger(bodyBytes) ||
      bodyBytes < 1 ||
      bodyBytes > 2 * 1024 * 1024 ||
      !Number.isInteger(headerBytes) ||
      headerBytes < 1024 ||
      headerBytes > 16_384
    ) {
      throw new KernelError("invalid");
    }
    this.#origin = origin;
    this.#consumer = options.consumerId;
    this.#control = options.controlCredential;
    this.#deadlineMs = deadlineMs;
    this.#bodyBytes = bodyBytes;
    this.#headerBytes = headerBytes;
    this.#admission = options.admission;
  }
  protected scope(
    scope: Pick<CandidateJournal, "consumerId" | "generation" | "accountRef" | "ownerRef">,
  ): void {
    if (scope.consumerId !== this.#consumer) {
      throw new NativeFailure("denied");
    }
    uuid(scope.generation);
    uuid(scope.accountRef);
    identifier(scope.ownerRef);
  }
  protected async call(
    method: "POST" | "GET" | "PUT",
    path: string,
    value?: unknown,
    deadlineMs = this.#deadlineMs,
  ): Promise<Buffer> {
    const deadline = Date.now() + Math.min(deadlineMs, this.#deadlineMs);
    let body: Buffer | undefined;
    try {
      body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
      if (body && body.length > (path.endsWith("/oauth/connect/complete") ? 32_768 : 16_384)) {
        throw new NativeFailure("bounded");
      }
    } catch {
      throw new NativeFailure("bounded");
    }
    let release: (() => void) | undefined;
    try {
      release = await this.#admission?.acquire(deadline);
    } catch {
      throw new NativeFailure("unavailable");
    }
    if (Date.now() >= deadline) {
      release?.();
      throw new NativeFailure("deadline");
    }
    return new Promise<Buffer>((resolve, reject) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: NativeFailure, bytes?: Buffer): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(bytes ?? Buffer.alloc(0));
        }
        req.destroy();
      };
      const send = this.#origin.protocol === "https:" ? httpsRequest : httpRequest;
      let req: ReturnType<typeof httpRequest>;
      try {
        req = send(this.#origin, {
          method,
          path,
          agent: false,
          maxHeaderSize: this.#headerBytes,
          headers: {
            authorization: "Bearer " + this.#control,
            accept: "application/json",
            connection: "close",
            ...(body
              ? { "content-type": "application/json", "content-length": String(body.length) }
              : {}),
          },
        });
      } catch {
        release?.();
        reject(new NativeFailure("unavailable"));
        return;
      }
      let physical = false;
      req.once("socket", (socket) => {
        physical = true;
        socket.once("close", () => release?.());
      });
      req.once("close", () => {
        if (!physical) {
          release?.();
        }
      });
      req.maxHeadersCount = 65;
      timer = setTimeout(
        () => {
          finish(new NativeFailure("deadline"));
        },
        Math.max(1, deadline - Date.now()),
      );
      req.on("error", () => {
        finish(new NativeFailure("unavailable"));
      });
      req.on("response", (res) => {
        // Retain one overflow sentinel beyond 64 pairs; Node truncates the rest.
        if (res.rawHeaders.length > 128) {
          finish(new NativeFailure("bounded"));
          res.destroy();
          req.destroy();
          return;
        }
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          finish(new NativeFailure(status >= 300 && status < 400 ? "redirect" : "unavailable"));
          res.destroy();
          req.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > this.#bodyBytes) {
            finish(new NativeFailure("bounded"));
            res.destroy();
            req.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        res.on("aborted", () => {
          finish(new NativeFailure("unavailable"));
        });
        res.on("error", () => {
          finish(new NativeFailure("unavailable"));
        });
        res.on("end", () => {
          finish(undefined, Buffer.concat(chunks));
        });
      });
      // No redirect handler, reuse agent, retry, provider route or consumer bearer.
      if (body) {
        req.end(body);
      } else {
        req.end();
      }
    });
  }
}
// Separate inert custody protocol. Metadata GET is intentionally insufficient.
