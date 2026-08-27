import type { AgentCard, AgentInvocation, AgentResult, Evidence } from '@scp/contracts';
import { checkAgentResult } from '@scp/contracts';
import type { AgentRegistry } from '@scp/agent-registry';
import type { AguiEvent } from '../agui/events.js';
import type {
  A2AArtifact,
  A2AMessage,
  A2APart,
  A2AStreamResult,
  A2ATextPart,
} from './a2a.js';
import { detectToolSignal } from './tool-signal.js';

export interface MapperOptions {
  invocation: AgentInvocation;
  card: AgentCard;
  registry: AgentRegistry;
  threadId: string;
  runId: string;
}

export interface ObservedToolCall {
  tool_call_id: string;
  name: string;
}

/**
 * Translates one A2A stream into AG-UI events and an AgentResult.
 *
 * Deliberately stateless about domain meaning (SPEC §11): it maps shapes, it does
 * not reason. Everything it cannot classify still surfaces as a CUSTOM event so
 * the Portal shows it rather than silently dropping agent output.
 */
export class A2AToAguiMapper {
  private readonly evidence: Evidence[] = [];
  private readonly toolNames = new Map<string, string>();
  private readonly openToolCalls = new Set<string>();
  private readonly emittedText = new Map<string, string>();
  private readonly assistantText: string[] = [];
  private structuredResult?: AgentResult;
  private currentMessageId?: string;
  private finalState?: string;
  private errorMessage?: string;

  readonly observedTools: ObservedToolCall[] = [];
  contextId?: string;
  taskId?: string;

  constructor(private readonly opts: MapperOptions) {}

  runStarted(): AguiEvent {
    return { type: 'RUN_STARTED', threadId: this.opts.threadId, runId: this.opts.runId };
  }

  /** Maps one A2A result object into zero or more AG-UI events. */
  *map(result: A2AStreamResult): Generator<AguiEvent> {
    switch (result.kind) {
      case 'task': {
        this.contextId = result.contextId;
        this.taskId = result.id;
        yield { type: 'STEP_STARTED', stepName: this.opts.card.name };
        if (result.status.message) yield* this.mapMessage(result.status.message);
        break;
      }
      case 'status-update': {
        this.contextId ??= result.contextId;
        this.taskId ??= result.taskId;
        if (result.status.message) yield* this.mapMessage(result.status.message);
        if (result.status.state !== 'working' && result.status.state !== 'submitted') {
          this.finalState = result.status.state;
        }
        break;
      }
      case 'artifact-update': {
        yield* this.mapArtifact(result.artifact);
        break;
      }
      default: {
        // A bare Message (non-task agents answer this way).
        const message = result as A2AMessage;
        if (message.role === 'agent' && Array.isArray(message.parts)) {
          this.contextId ??= message.contextId;
          yield* this.mapMessage(message);
        }
      }
    }
  }

  private *mapMessage(message: A2AMessage): Generator<AguiEvent> {
    if (message.role === 'user') return;
    const messageId = message.messageId || `msg-${this.opts.runId}`;
    for (const part of message.parts ?? []) {
      yield* this.mapPart(part, messageId);
    }
  }

  private *mapPart(part: A2APart, messageId: string): Generator<AguiEvent> {
    if (part.kind === 'text') {
      const text = (part as A2ATextPart).text ?? '';
      if (text) yield* this.emitText(messageId, text);
      return;
    }

    const signal = detectToolSignal(part);
    if (signal?.phase === 'call') {
      // Defence in depth: a write tool must never execute, even if kagent is
      // misconfigured. We cannot stop kagent from running it, but we refuse to
      // relay the run and the caller aborts it (SPEC §14).
      this.opts.registry.assertToolAllowed(this.opts.card.id, signal.name);

      this.toolNames.set(signal.toolCallId, signal.name);
      this.observedTools.push({ tool_call_id: signal.toolCallId, name: signal.name });
      this.openToolCalls.add(signal.toolCallId);
      yield {
        type: 'TOOL_CALL_START',
        toolCallId: signal.toolCallId,
        toolCallName: signal.name,
        parentMessageId: this.currentMessageId,
      };
      if (signal.args !== undefined) {
        yield {
          type: 'TOOL_CALL_ARGS',
          toolCallId: signal.toolCallId,
          delta:
            typeof signal.args === 'string'
              ? signal.args
              : JSON.stringify(signal.args),
        };
      }
      yield { type: 'TOOL_CALL_END', toolCallId: signal.toolCallId };
      this.openToolCalls.delete(signal.toolCallId);
      return;
    }

    if (signal?.phase === 'result') {
      const name = signal.name ?? this.toolNames.get(signal.toolCallId) ?? 'tool';
      yield {
        type: 'TOOL_CALL_RESULT',
        messageId: `${signal.toolCallId}-result`,
        toolCallId: signal.toolCallId,
        content: signal.content,
        role: 'tool',
      };
      this.evidence.push({
        id: `tool-ev-${this.evidence.length + 1}`,
        kind: 'command_output',
        label: `${name} output`,
        source: name,
        content: signal.content.slice(0, 20000),
      });
      return;
    }

    // Unclassified data part: surface it rather than lose it.
    yield {
      type: 'CUSTOM',
      name: 'a2a.data_part',
      value: (part as { data?: unknown }).data ?? part,
    };
  }

  private *mapArtifact(artifact: A2AArtifact): Generator<AguiEvent> {
    for (const part of artifact.parts ?? []) {
      if (part.kind === 'data') {
        const data = (part as { data?: unknown }).data;
        if (this.adoptStructuredResult(data)) continue;
        yield { type: 'CUSTOM', name: 'a2a.artifact', value: { artifact: artifact.name, data } };
        continue;
      }
      if (part.kind === 'text') {
        const text = (part as A2ATextPart).text ?? '';
        if (!text) continue;
        // An agent may return the structured result as JSON text.
        if (this.adoptStructuredResult(safeParse(text))) continue;
        this.evidence.push({
          id: `tool-ev-${this.evidence.length + 1}`,
          kind: 'document',
          label: artifact.name ?? `artifact ${artifact.artifactId}`,
          source: this.opts.card.id,
          content: text.slice(0, 20000),
        });
        yield {
          type: 'CUSTOM',
          name: 'a2a.artifact',
          value: { artifact: artifact.name, text },
        };
      }
    }
  }

  /** Accepts an agent-supplied AgentResult only if it actually satisfies the contract. */
  private adoptStructuredResult(candidate: unknown): boolean {
    if (!candidate || typeof candidate !== 'object') return false;
    const withTrace = {
      ...(candidate as Record<string, unknown>),
      trace: {
        trace_id: this.opts.invocation.correlation.trace_id,
        agent_run_id: this.opts.runId,
        request_id: this.opts.invocation.request_id,
      },
    };
    if (checkAgentResult(withTrace).ok) {
      this.structuredResult = withTrace as unknown as AgentResult;
      return true;
    }
    return false;
  }

  /**
   * Emits only text the Portal has not seen yet.
   *
   * Some A2A servers stream deltas and some resend the whole message each
   * update. Comparing against what we already emitted for this messageId makes
   * both behave the same and stops cumulative servers duplicating output.
   */
  private *emitText(messageId: string, text: string): Generator<AguiEvent> {
    const already = this.emittedText.get(messageId);

    if (already === undefined) {
      if (this.currentMessageId && this.currentMessageId !== messageId) {
        yield { type: 'TEXT_MESSAGE_END', messageId: this.currentMessageId };
      }
      this.currentMessageId = messageId;
      yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
      this.emittedText.set(messageId, text);
      this.assistantText.push(text);
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text };
      return;
    }

    const delta = text.startsWith(already) ? text.slice(already.length) : text;
    if (!delta) return;
    this.emittedText.set(messageId, already + delta);
    this.assistantText.push(delta);
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta };
  }

  markFailed(message: string): void {
    this.finalState = 'failed';
    this.errorMessage = message;
  }

  markCancelled(): void {
    this.finalState = 'canceled';
  }

  /** Closes any message left open, then emits the result state and RUN_FINISHED. */
  *finish(): Generator<AguiEvent> {
    for (const toolCallId of this.openToolCalls) {
      yield { type: 'TOOL_CALL_END', toolCallId };
    }
    this.openToolCalls.clear();

    if (this.currentMessageId) {
      yield { type: 'TEXT_MESSAGE_END', messageId: this.currentMessageId };
      this.currentMessageId = undefined;
    }

    const result = this.buildResult();
    yield { type: 'STEP_FINISHED', stepName: this.opts.card.name };
    yield { type: 'STATE_SNAPSHOT', snapshot: { result } };
    yield {
      type: 'RUN_FINISHED',
      threadId: this.opts.threadId,
      runId: this.opts.runId,
      result,
    };
  }

  buildResult(): AgentResult {
    const trace = {
      trace_id: this.opts.invocation.correlation.trace_id,
      agent_run_id: this.opts.runId,
      request_id: this.opts.invocation.request_id,
    };

    if (this.structuredResult) {
      // An agent that curated its own evidence keeps it. Raw tool output is
      // already visible in the timeline, so appending it here would just
      // duplicate every row. Tool evidence only fills a genuine gap.
      const curated = this.structuredResult.evidence ?? [];
      return {
        ...this.structuredResult,
        trace,
        evidence: curated.length > 0 ? curated : this.evidence,
      };
    }

    // Fallback for agents that answer in prose - the common case until agents are
    // taught to emit AgentResult directly. The Portal renders both identically.
    const text = this.assistantText.join('');
    return {
      status: this.mapStatus(),
      summary: text.trim() || 'Agent produced no textual answer.',
      findings: [],
      evidence: this.evidence,
      recommendations: [],
      followups: [],
      trace,
      ...(this.errorMessage
        ? { error: { code: 'AGENT_FAILED', message: this.errorMessage } }
        : {}),
    };
  }

  private mapStatus(): AgentResult['status'] {
    switch (this.finalState) {
      case 'failed':
      case 'rejected':
        return 'failed';
      case 'canceled':
        return 'cancelled';
      case 'input-required':
        return 'needs_input';
      default:
        return 'completed';
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
