import type { IncomingMessage, ServerResponse } from "node:http";
import { KernelError } from "./domain.ts";
import type { Schema } from "./facade-contract-parse.ts";

// Keep HTTP header cardinality, byte budgets and response framing in one adapter.
export function singleton(req: IncomingMessage, name: string, required = true): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name) {
      values.push(req.rawHeaders[i + 1]);
    }
  }
  if (values.length !== (required ? 1 : 0) && !(values.length === 1 && !required)) {
    throw new KernelError("invalid");
  }
  return values[0];
}
export async function body(req: IncomingMessage, maximum: number): Promise<Uint8Array> {
  const content = singleton(req, "content-type");
  if (content !== "application/json") {
    throw new KernelError("invalid");
  }
  const encoding = singleton(req, "content-encoding", false);
  if (encoding !== undefined) {
    throw new KernelError("invalid");
  }
  const length = singleton(req, "content-length", false);
  if (length !== undefined && (!/^(0|[1-9]\d*)$/.test(length) || Number(length) > maximum)) {
    throw new KernelError("invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk as Uint8Array);
    size += part.byteLength;
    if (size > maximum) {
      throw new KernelError("invalid");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, size);
}
export function send<T>(
  res: ServerResponse,
  schema: Pick<Schema<T>, "parse">,
  value: T,
  status = 200,
  privateCache = false,
  maximumBytes = 65_536,
): void {
  const bytes = JSON.stringify(schema.parse(value));
  if (Buffer.byteLength(bytes) > maximumBytes) {
    throw new KernelError("unavailable");
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": privateCache ? "private, no-store" : "no-store",
    "content-length": Buffer.byteLength(bytes),
  });
  res.end(bytes);
}
