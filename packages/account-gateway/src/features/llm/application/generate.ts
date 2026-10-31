import { GatewayError } from "../../facade-client/http/index.js";
import type { Prepare } from "../../facade-client/contracts/index.js";
import {
  LLM_DEFAULT_OUTPUT_BYTES,
  LLM_MAX_DEADLINE_MS,
  LLM_MAX_REQUEST_BYTES,
  admissibleTask,
  classifyFault,
  classifyReadback,
  interruptedVerdict,
  settleGeneration,
  taskIdentity,
} from "../domain/index.js";
import type {
  FailureVerdict,
  GatewayFault,
  LlmCleanup,
  LlmExecution,
  LlmFailure,
  LlmResult,
  LlmSuccess,
  LlmTask,
  LlmUsage,
} from "../domain/index.js";
import type { ExecutionPort, LlmClient, LlmClientConfig, ModelProtocol } from "./ports.js";

type Access = Awaited<ReturnType<LlmClientConfig["control"]["runAccess"]>>;
type Interruption = "cancelled" | "deadline";
type Settled<T> = {
  readonly result: Omit<LlmSuccess<T>, "cleanup"> | Omit<LlmFailure, "cleanup">;
  readonly reason: "completed" | "failed" | Interruption;
};

const invalidTask: FailureVerdict = {
  code: "invalid_task",
  effect: "not_dispatched",
  retry: { kind: "never" },
};

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function faultOf(stage: GatewayFault["stage"], error: unknown): GatewayFault {
  if (!(error instanceof GatewayError)) {
    return { stage, kind: "transport", effect: "effect_unknown" };
  }
  const diagnostic = error.diagnostic;
  return {
    stage,
    kind: error.code,
    effect: error.effect,
    ...(diagnostic ? { code: diagnostic.code, traceRef: diagnostic.traceRef } : {}),
    ...(diagnostic?.retry.kind === "after" ? { afterMs: diagnostic.retry.milliseconds } : {}),
  };
}

/** The issued grant must be exactly this attempt's intent before any inference byte is sent. */
function grantMatches(access: Access, intent: Prepare, deadline: number): boolean {
  const { operation, admission } = access;
  const result = operation.state === "applied" ? operation.result : undefined;
  return (
    operation.operationRef === intent.operationId &&
    result?.kind === "execution" &&
    result.state === "active" &&
    result.accountRef === admission.accountRef &&
    intent.accountRefs.includes(admission.accountRef) &&
    admission.invocationRef === intent.invocationRef &&
    admission.attemptRef === intent.attemptRef &&
    admission.subjectRef === intent.subjectRef &&
    admission.policyRevision === intent.policyRevision &&
    admission.bindingRevision === intent.bindingRevision &&
    admission.profileId === intent.profileId &&
    Date.parse(admission.expiresAt) === deadline &&
    Date.parse(result.deadline) === deadline &&
    (Object.keys(intent.limits) as (keyof Prepare["limits"])[]).every(
      (key) => admission.limits[key] === intent.limits[key],
    )
  );
}

function failed(
  verdict: FailureVerdict,
  cleanup: LlmCleanup = "not_needed",
  execution: LlmExecution | null = null,
): LlmFailure {
  return { ok: false, ...verdict, execution, usage: null, cleanup };
}

/** Caller cancellation or the deadline replaces the code and keeps the observed effect. */
function settle<T>(
  observed: FailureVerdict,
  execution: LlmExecution,
  usage: LlmUsage | null,
  interruption: () => Interruption | undefined,
): Settled<T> {
  const reason = interruption();
  const verdict = reason ? interruptedVerdict(reason, observed) : observed;
  return { result: { ok: false, ...verdict, execution, usage }, reason: reason ?? "failed" };
}

/**
 * One attempt: run access, one request, stream reduction, status readback after an
 * ambiguous loss, and close with an independent bound. Nothing is retried here.
 */
export function createLlmGenerator(
  config: LlmClientConfig & { readonly protocol: ModelProtocol },
): LlmClient {
  const now = config.now ?? Date.now;
  const controlTimeoutMs = config.controlTimeoutMs ?? 10_000;
  if (
    !Number.isSafeInteger(controlTimeoutMs) ||
    controlTimeoutMs < 1 ||
    controlTimeoutMs > 60_000
  ) {
    throw new GatewayError("invalid_input", "not_dispatched");
  }

  async function generate<T>(
    task: LlmTask<T>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LlmResult<T>> {
    const started = now();
    let body: Uint8Array<ArrayBuffer>;
    try {
      if (!admissibleTask(task, started)) {
        return failed(invalidTask);
      }
      body = config.protocol.encode(task);
    } catch {
      return failed(invalidTask);
    }
    if (body.byteLength > LLM_MAX_REQUEST_BYTES) {
      return failed(invalidTask);
    }
    if (options.signal?.aborted === true) {
      return failed({ code: "cancelled", effect: "not_dispatched", retry: { kind: "never" } });
    }
    const controller = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, task.deadline.getTime() - started);
    const cancel = () => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const interruption = (): Interruption | undefined =>
      options.signal?.aborted === true ? "cancelled" : expired ? "deadline" : undefined;
    try {
      return await attempt(task, body, started, controller.signal, interruption);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    }
  }

  async function attempt<T>(
    task: LlmTask<T>,
    body: Uint8Array<ArrayBuffer>,
    started: number,
    signal: AbortSignal,
    interruption: () => Interruption | undefined,
  ): Promise<LlmResult<T>> {
    const id = taskIdentity(task);
    const deadline = task.deadline.getTime();
    const remainingMs = deadline - started;
    const intent: Prepare = {
      operationId: id.prepareId,
      invocationRef: id.invocationRef,
      attemptRef: id.attemptRef,
      accountRefs: [...task.accountRefs],
      subjectRef: task.policy.subjectRef,
      policyRevision: task.policy.policyRevision,
      bindingRevision: task.policy.bindingRevision,
      profileId: task.profileId,
      limits: {
        requests: 1,
        concurrency: 1,
        requestBytes: body.byteLength,
        outputBytes: task.limits?.outputBytes ?? LLM_DEFAULT_OUTPUT_BYTES,
        tokens: task.maxOutputTokens,
      },
      deadline: task.deadline.toISOString(),
    };
    let access: Access;
    try {
      access = await config.control.runAccess(intent, { signal });
    } catch (error) {
      const fault = faultOf("access", error);
      const observed = classifyFault(fault);
      const reason = interruption();
      // An ambiguous grant may stay live until its deadline; identical replay recovers it.
      const live = fault.effect === "effect_unknown" || observed.retry.kind === "same_attempt";
      return failed(
        reason ? interruptedVerdict(reason, observed) : observed,
        live ? "pending" : "not_needed",
      );
    }
    const grant = access.operation.state === "applied" ? access.operation.result : undefined;
    if (grant?.kind !== "execution") {
      return failed(
        {
          code: "unavailable",
          effect: "not_dispatched",
          retry: { kind: "same_attempt", afterMs: 0 },
        },
        "pending",
      );
    }
    const execution: LlmExecution = {
      executionRef: grant.executionRef,
      requestRef: id.requestId,
      accountRef: access.admission.accountRef,
      authorizationEpoch: access.admission.authorizationEpoch,
    };
    let port: ExecutionPort;
    try {
      port = config.connectExecution({
        bearer: access.bearer,
        timeoutMs: Math.min(LLM_MAX_DEADLINE_MS, remainingMs + 1000),
      });
    } catch {
      // Without a client the grant cannot be closed; it expires at its deadline.
      return failed(
        {
          code: "unavailable",
          effect: "not_dispatched",
          retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: false },
        },
        "pending",
        execution,
      );
    }
    const settled = grantMatches(access, intent, deadline)
      ? await infer(task, body, access, execution, port, signal, interruption)
      : settle<T>(
          {
            code: "unavailable",
            effect: "not_dispatched",
            retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: false },
          },
          execution,
          null,
          interruption,
        );
    let cleanup: "closed" | "pending" = "pending";
    try {
      const closed = await port.close(
        execution.executionRef,
        { operationId: id.closeId, reason: settled.reason },
        { signal: AbortSignal.timeout(controlTimeoutMs) },
      );
      cleanup =
        closed.state === "applied" && closed.operationRef === id.closeId ? "closed" : "pending";
    } catch {
      // The grant still expires at its deadline; the consumer sees pending cleanup.
    }
    return { ...settled.result, cleanup };
  }

  async function infer<T>(
    task: LlmTask<T>,
    body: Uint8Array<ArrayBuffer>,
    access: Access,
    execution: LlmExecution,
    port: ExecutionPort,
    signal: AbortSignal,
    interruption: () => Interruption | undefined,
  ): Promise<Settled<T>> {
    const fail = (verdict: FailureVerdict, usage: LlmUsage | null = null) =>
      settle<T>(verdict, execution, usage, interruption);
    // Readback has its own bound: a cancelled or expired task still learns its effect.
    const readback = async (fallback: GatewayFault): Promise<FailureVerdict> => {
      try {
        const status = await port.status(execution.executionRef, execution.requestRef, {
          signal: AbortSignal.timeout(controlTimeoutMs),
        });
        return classifyReadback(status);
      } catch {
        return classifyFault(fallback);
      }
    };
    const lost: GatewayFault = { stage: "inference", kind: "transport", effect: "effect_unknown" };
    try {
      let response: Awaited<ReturnType<ExecutionPort["request"]>>;
      try {
        response = await port.request(
          execution.executionRef,
          { requestId: execution.requestRef, admission: access.admission, body },
          { signal },
        );
      } catch (error) {
        const fault = faultOf("inference", error);
        return fail(
          fault.effect === "effect_unknown" && fault.kind !== "invalid_input"
            ? await readback(fault)
            : classifyFault(fault),
        );
      }
      if (response.kind === "status") {
        return fail(classifyReadback(response.status));
      }
      const decoder = config.protocol.decoder();
      const reader = response.body.getReader();
      let consumed = false;
      let outcome: ReturnType<typeof decoder.finish>;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            consumed = true;
            break;
          }
          decoder.push(chunk.value);
        }
        outcome = decoder.finish();
      } catch (error) {
        if (!(error instanceof GatewayError)) {
          // Malformed provider bytes after the response started.
          return fail(classifyFault({ ...lost, kind: "safe_error", effect: "response_started" }));
        }
        if (error.code === "invalid_response" && !interruption()) {
          // The stream client raises this only for its chunk and output byte bounds.
          return fail({
            code: "output_truncated",
            effect: "response_started",
            retry: { kind: "new_attempt", afterMs: 0, mayDuplicateCost: true },
          });
        }
        return fail(
          interruption()
            ? classifyFault({ ...lost, kind: "cancelled", effect: "response_started" })
            : await readback(lost),
        );
      } finally {
        reader.releaseLock();
        if (!consumed) {
          await response.cancel().catch(() => {});
        }
      }
      if (outcome.status === "interrupted") {
        return fail(await readback(lost));
      }
      const settled = settleGeneration(outcome, task);
      if (!settled.ok) {
        return fail(settled, outcome.usage);
      }
      const receipt = {
        ...execution,
        taskId: task.taskId,
        attempt: task.attempt,
        profileId: task.profileId,
        model: task.model,
        observedModel: outcome.observedModel,
        responseId: outcome.responseId,
        requestSha256: await sha256(body),
        outputSha256: await sha256(new TextEncoder().encode(outcome.text)),
      };
      return {
        result: {
          ok: true,
          value: settled.value,
          text: outcome.text,
          usage: outcome.usage,
          receipt,
        },
        reason: "completed",
      };
    } catch {
      // A decoder or port defect never escapes as an exception; the effect is unknown.
      return fail(classifyFault(lost));
    }
  }

  return Object.freeze({ generate });
}
