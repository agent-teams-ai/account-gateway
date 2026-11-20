import { spawn } from "node:child_process";

interface CommandStatus {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputLimit: boolean;
}
export class CommandFailure extends Error {
  readonly output: string;
  readonly stdout: string;
  readonly status: CommandStatus;
  constructor(output: string, stdout: string, status: CommandStatus) {
    super("joined-command-failed");
    this.output = output;
    this.stdout = stdout;
    this.status = status;
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
  child.stdout.on("data", (bytes: Buffer) => {
    capture(bytes, "stdout");
  });
  child.stderr.on("data", (bytes: Buffer) => {
    capture(bytes, "stderr");
  });
  const timer = setTimeout(() => {
    expired = true;
    kill();
  }, options.timeout ?? 30_000);
  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  }).finally(() => {
    clearTimeout(timer);
  });
  const stdout = output
    .filter((chunk) => chunk.stream === "stdout")
    .map((chunk) => chunk.text)
    .join("");
  const commandFailed = () => expired || overflow;
  if (commandFailed() || result.exitCode !== (options.expected ?? 0)) {
    throw new CommandFailure(output.map((chunk) => chunk.text).join(""), stdout, {
      ...result,
      timedOut: expired,
      outputLimit: overflow,
    });
  }
  // Successful proof stdout remains a strict protocol. Diagnostics still spend
  // the shared byte budget and remain available only to failed-command sanitization.
  return stdout;
}
