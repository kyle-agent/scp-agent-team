import type { AgentInvocation, AgentResult } from '@scp/contracts';
import type { AgentRegistry } from '@scp/agent-registry';
import type { AguiEvent } from './agui/events.js';
import { A2AError, streamMessage } from './kagent/a2a.js';
import { A2AToAguiMapper, type ObservedToolCall } from './kagent/map-to-agui.js';
import { composePrompt } from './prompt.js';

export interface RunContext {
  threadId: string;
  runId: string;
  signal: AbortSignal;
  /** Reused across follow-ups in one Portal session so kagent keeps context. */
  contextId?: string;
}

/**
 * The seam every access mode sits behind (SPEC §21).
 *
 * Today: A2AAgentInvoker (kagent over A2A). Later: a peer-to-peer A2A invoker or
 * a direct kagent REST invoker can be dropped in without touching the Portal,
 * the AG-UI route, or the future MCP route.
 *
 * The generator yields AG-UI events and *returns* the AgentResult, so an MCP
 * adapter can drain the events it does not need and keep only the result.
 */
export interface AgentInvoker {
  readonly kind: string;
  run(
    invocation: AgentInvocation,
    ctx: RunContext,
  ): AsyncGenerator<AguiEvent, AgentResult>;
  /** Populated as the run proceeds; read after draining, for audit. */
  toolsFor(runId: string): ObservedToolCall[];
  contextIdFor(runId: string): string | undefined;
}

export interface A2AInvokerOptions {
  baseUrl: string;
  registry: AgentRegistry;
  /** Forwarded to kagent so the platform can attribute the run to a real user. */
  buildHeaders?: (invocation: AgentInvocation) => Record<string, string>;
}

export class A2AAgentInvoker implements AgentInvoker {
  readonly kind = 'kagent-a2a';
  private readonly tools = new Map<string, ObservedToolCall[]>();
  private readonly contexts = new Map<string, string>();

  constructor(private readonly opts: A2AInvokerOptions) {}

  toolsFor(runId: string): ObservedToolCall[] {
    return this.tools.get(runId) ?? [];
  }

  contextIdFor(runId: string): string | undefined {
    return this.contexts.get(runId);
  }

  async *run(
    invocation: AgentInvocation,
    ctx: RunContext,
  ): AsyncGenerator<AguiEvent, AgentResult> {
    const card = this.opts.registry.require(invocation.agent);
    const mapper = new A2AToAguiMapper({
      invocation,
      card,
      registry: this.opts.registry,
      threadId: ctx.threadId,
      runId: ctx.runId,
    });
    this.tools.set(ctx.runId, mapper.observedTools);

    yield mapper.runStarted();

    try {
      const stream = streamMessage({
        baseUrl: this.opts.baseUrl,
        namespace: card.runtime.namespace,
        agentName: card.runtime.name,
        text: composePrompt(invocation, card),
        contextId: ctx.contextId,
        messageId: invocation.request_id,
        metadata: {
          scp_trace_id: invocation.correlation.trace_id,
          scp_request_id: invocation.request_id,
          scp_access_mode: invocation.actor.type,
          scp_user_id: invocation.actor.user_id,
        },
        headers: this.opts.buildHeaders?.(invocation),
        signal: ctx.signal,
      });

      for await (const result of stream) {
        yield* mapper.map(result);
        if (mapper.contextId) this.contexts.set(ctx.runId, mapper.contextId);
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        mapper.markCancelled();
      } else {
        const code = err instanceof A2AError ? err.code : 'ADAPTER_ERROR';
        const message = (err as Error).message;
        mapper.markFailed(message);
        yield { type: 'RUN_ERROR', message, code };
        // Still finish so the Portal gets a terminal state and a result to render.
      }
    }

    yield* mapper.finish();
    return mapper.buildResult();
  }
}
