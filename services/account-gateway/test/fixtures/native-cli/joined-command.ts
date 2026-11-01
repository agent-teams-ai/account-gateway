import { spawn } from "node:child_process";

export class CommandFailure extends Error {
  readonly output: string;
  constructor(output: string) {
    super("joined-command-failed");
    this.output = output;
  }
}
export async function command(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { uid?: number; timeout?: number; expected?: number; cwd?: string } = {},
) {
  const child = spawn(binary, args, {
    cwd: options.cwd,
    env,
    uid: options.uid,
    gid: options.uid,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const output: { stream: "stdout" | "stderr"; text: string }[] = [];
  let size = 0,
    overflow = false,
    expired = false;
  const kill = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  };
  const capture = (bytes: Buffer, stream: "stdout" | "stderr") => {
    size += bytes.length;
    if (size > 4_194_304) {
      overflow = true;
      kill();
    } else {
      output.push({ stream, text: bytes.toString("utf8") });
    }
  };
  child.stdout.on("data", (bytes: Buffer) => capture(bytes, "stdout"));
  child.stderr.on("data", (bytes: Buffer) => capture(bytes, "stderr"));
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, options.timeout ?? 30_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
  });
  const commandFailed = () => expired || overflow;
  if (commandFailed() || code !== (options.expected ?? 0)) {
    throw new CommandFailure(output.map((chunk) => chunk.text).join(""));
  }
  // Successful proof stdout remains a strict protocol. Diagnostics still spend
  // the shared byte budget and remain available only to failed-command sanitization.
  return output
    .filter((chunk) => chunk.stream === "stdout")
    .map((chunk) => chunk.text)
    .join("");
}
