import type {
  AgentCard,
  AgentInvocation,
  AgentResult,
  Evidence,
  PlanStep,
  PlanStepStatus,
  RunSharedState,
} from '@scp/contracts';
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
import { PlanTextFilter, detectPlanSignal } from './plan.js';
import {
  authorOf,
  delegationFromPart,
  delegationFromTool,
  type DelegationSignal,
} from './subagent.js';
import { attribute } from '../agui/events.js';

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
  /** Which participant ran it, when the run involved more than one agent. */
  subagent?: string;
}

interface ActiveSubagent {
  runId: string;
  name: string;
  parentToolCallId?: string;
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
  private readonly planFilter = new PlanTextFilter();
  /** Innermost first is the top of the stack; delegation can nest. */
  private readonly subagentStack: ActiveSubagent[] = [];
  private readonly knownAgents: ReadonlySet<string>;
  private subagentCount = 0;
  private plan?: PlanStep[];
  private structuredResult?: AgentResult;
  /** The A2A message currently open, and the AG-UI id standing in for it. */
  private currentSourceMessageId?: string;
  private currentMessageId?: string;
  private readonly reopenCount = new Map<string, number>();
  private finalState?: string;
  private errorMessage?: string;

  readonly observedTools: ObservedToolCall[] = [];
  /** Every agent that took part, in the order they first appeared. Audited. */
  readonly participants: string[] = [];
  contextId?: string;
  taskId?: string;

  constructor(private readonly opts: MapperOptions) {
    // A supervisor calls its specialists by name, so the shared agent ids are
    // what tells a delegation apart from an ordinary tool call.
    this.knownAgents = new Set(
      opts.registry
        .list()
        .map((card) => card.id)
        .filter((id) => id !== opts.card.id),
    );
  }

  private get currentSubagentRunId(): string | undefined {
    return this.subagentStack.at(-1)?.runId;
  }

  runStarted(): AguiEvent {
    return { type: 'RUN_STARTED', threadId: this.opts.threadId, runId: this.opts.runId };
  }

  /**
   * Maps one A2A result object into zero or more AG-UI events.
   *
   * Wraps the mapping so everything produced while a sub-agent holds the floor
   * is attributed to it. Without that, a specialist's tool calls read as though
   * the agent the user invoked had made them.
   */
  *map(result: A2AStreamResult): Generator<AguiEvent> {
    for (const event of this.mapResult(result)) {
      yield attribute(event, this.currentSubagentRunId);
    }
  }

  private *mapResult(result: A2AStreamResult): Generator<AguiEvent> {
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
    yield* this.followAuthor(message);
    const messageId = message.messageId || `msg-${this.opts.runId}`;
    for (const part of message.parts ?? []) {
      yield* this.mapPart(part, messageId);
    }
  }

  /**
   * Switches participant when the stream says a different agent is speaking.
   *
   * This is the only delegation signal available when a supervisor's sub-agents
   * run internally rather than through a visible tool call.
   */
  private *followAuthor(message: A2AMessage): Generator<AguiEvent> {
    const author = authorOf(message);
    if (!author) return;

    const isRoot = author === this.opts.card.id || author === this.opts.card.runtime.name;
    const current = this.subagentStack.at(-1);

    if (isRoot) {
      while (this.subagentStack.length > 0) yield* this.endSubagent();
      return;
    }
    if (current?.name === author) return;

    // A different specialist took over: close the previous one first, so the
    // timeline never shows two agents holding the floor at once.
    if (current) yield* this.endSubagent();
    yield* this.startSubagent({ name: author });
  }

  private *mapPart(part: A2APart, messageId: string): Generator<AguiEvent> {
    if (part.kind === 'text') {
      const text = (part as A2ATextPart).text ?? '';
      if (text) yield* this.emitText(messageId, text);
      return;
    }

    const planSignal = detectPlanSignal(part);
    if (planSignal?.kind === 'plan') {
      yield* this.adoptPlan(planSignal.steps);
      return;
    }
    if (planSignal?.kind === 'plan-step') {
      yield* this.setStepStatus(planSignal.id, planSignal.status, planSignal.detail);
      return;
    }

    const explicitDelegation = delegationFromPart(part);
    if (explicitDelegation) {
      yield* this.applyDelegation(explicitDelegation);
      return;
    }

    const signal = detectToolSignal(part);
    if (signal) {
      // A delegation wears the shape of a tool call. Showing it as one would
      // reduce "the Network Agent investigated" to "a tool was called".
      const delegation = delegationFromTool(signal, this.knownAgents);
      if (delegation) {
        yield* this.applyDelegation(delegation);
        return;
      }
    }

    if (signal?.phase === 'call') {
      // Defence in depth: a write tool must never execute, even if kagent is
      // misconfigured. We cannot stop kagent from running it, but we refuse to
      // relay the run and the caller aborts it (SPEC §14).
      this.opts.registry.assertToolAllowed(this.opts.card.id, signal.name);

      this.toolNames.set(signal.toolCallId, signal.name);
      this.observedTools.push({
        tool_call_id: signal.toolCallId,
        name: signal.name,
        ...(this.subagentStack.at(-1) ? { subagent: this.subagentStack.at(-1)!.name } : {}),
      });
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
      yield* this.advancePlanForTool(signal.name, 'call');
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
      yield* this.advancePlanForTool(name, 'result');
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

  // --- sub-agents -----------------------------------------------------------

  private *applyDelegation(signal: DelegationSignal): Generator<AguiEvent> {
    if (signal.phase === 'start') {
      yield* this.startSubagent(signal);
      return;
    }

    // Close the sub-agent this end belongs to. Matching on the originating tool
    // call is what keeps nested delegations from unwinding in the wrong order.
    const index = signal.parentToolCallId
      ? this.subagentStack.findIndex((s) => s.parentToolCallId === signal.parentToolCallId)
      : signal.name
        ? this.subagentStack.findIndex((s) => s.name === signal.name)
        : this.subagentStack.length - 1;
    if (index === -1) return;

    while (this.subagentStack.length > index) {
      yield* this.endSubagent(signal.result);
    }
  }

  private *startSubagent(signal: {
    name: string;
    description?: string;
    parentToolCallId?: string;
  }): Generator<AguiEvent> {
    // Close any message the parent had open, so its text does not appear to
    // continue underneath the sub-agent.
    yield* this.closeOpenMessage();

    const parent = this.subagentStack.at(-1);
    const runId = `${this.opts.runId}-sub-${++this.subagentCount}`;
    if (!this.participants.includes(signal.name)) this.participants.push(signal.name);
    this.subagentStack.push({
      runId,
      name: signal.name,
      ...(signal.parentToolCallId ? { parentToolCallId: signal.parentToolCallId } : {}),
    });

    yield {
      type: 'SUBAGENT_STARTED',
      subagentRunId: runId,
      name: signal.name,
      ...(signal.description ? { description: signal.description } : {}),
      ...(parent ? { parentSubagentRunId: parent.runId } : {}),
      ...(signal.parentToolCallId ? { parentToolCallId: signal.parentToolCallId } : {}),
    };
  }

  private *endSubagent(result?: unknown, error?: string): Generator<AguiEvent> {
    const active = this.subagentStack.pop();
    if (!active) return;

    yield* this.closeOpenMessage();

    yield error
      ? { type: 'SUBAGENT_ERROR', subagentRunId: active.runId, message: error }
      : {
          type: 'SUBAGENT_FINISHED',
          subagentRunId: active.runId,
          ...(result !== undefined ? { result } : {}),
        };
  }

  // --- plan -----------------------------------------------------------------

  private *adoptPlan(steps: PlanStep[]): Generator<AguiEvent> {
    this.plan = steps;
    yield this.stateSnapshot();
  }

  private *setStepStatus(
    id: string,
    status: PlanStepStatus,
    detail?: string,
  ): Generator<AguiEvent> {
    const step = this.plan?.find((s) => s.id === id);
    if (!step) return;
    step.status = status;
    if (detail) step.detail = detail;
    yield this.stateSnapshot();
  }

  /**
   * Moves a step along when its tool fires.
   *
   * Lets the checklist track reality even when the agent never reports progress
   * explicitly - it only has to declare the plan once, naming the tool per step.
   */
  private *advancePlanForTool(
    toolName: string,
    phase: 'call' | 'result',
  ): Generator<AguiEvent> {
    if (!this.plan) return;
    const wanted: PlanStepStatus = phase === 'call' ? 'pending' : 'running';
    const step = this.plan.find((s) => s.tool === toolName && s.status === wanted);
    if (!step) return;
    step.status = phase === 'call' ? 'running' : 'done';
    yield this.stateSnapshot();
  }

  /**
   * Settles the plan when the run ends.
   *
   * A step left `pending` would tell the user work is still coming when the run
   * is over, so unreached steps become `skipped` - the checklist must not
   * promise what was not done.
   */
  private settlePlan(): void {
    if (!this.plan) return;
    const failed = this.mapStatus() === 'failed';
    for (const step of this.plan) {
      if (step.status === 'running') step.status = failed ? 'failed' : 'done';
      else if (step.status === 'pending') step.status = 'skipped';
    }
  }

  private stateSnapshot(): AguiEvent {
    const state: RunSharedState = {};
    if (this.plan) state.plan = this.plan.map((step) => ({ ...step }));
    return { type: 'STATE_SNAPSHOT', snapshot: state };
  }

  // --- result ---------------------------------------------------------------

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
    let delta: string;

    if (already === undefined) {
      this.emittedText.set(messageId, text);
      delta = text;
    } else {
      delta = text.startsWith(already) ? text.slice(already.length) : text;
      if (!delta) return;
      this.emittedText.set(messageId, already + delta);
    }

    // A declared plan may be embedded in the text; it becomes a checklist rather
    // than prose, so it is stripped from what the Portal displays.
    const { text: display, steps } = this.planFilter.push(delta);
    if (display) yield* this.emitDisplayText(messageId, display);
    if (steps) yield* this.adoptPlan(steps);
  }

  private *emitDisplayText(sourceMessageId: string, display: string): Generator<AguiEvent> {
    if (this.currentSourceMessageId !== sourceMessageId) {
      yield* this.closeOpenMessage();
      this.currentSourceMessageId = sourceMessageId;
      this.currentMessageId = this.nextMessageId(sourceMessageId);
      yield { type: 'TEXT_MESSAGE_START', messageId: this.currentMessageId, role: 'assistant' };
    }
    this.assistantText.push(display);
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId: this.currentMessageId!, delta: display };
  }

  /**
   * A fresh AG-UI message id each time an A2A message is opened.
   *
   * kagent can stream a whole run under one A2A messageId. A delegation closes
   * the message and the caller's next line reopens it, so reusing the id would
   * mean two messages sharing one identity - an ended message restarted, which
   * AG-UI does not allow and which collides as a list key in the Portal.
   */
  private nextMessageId(sourceMessageId: string): string {
    const seen = this.reopenCount.get(sourceMessageId) ?? 0;
    this.reopenCount.set(sourceMessageId, seen + 1);
    return seen === 0 ? sourceMessageId : `${sourceMessageId}#${seen + 1}`;
  }

  private *closeOpenMessage(): Generator<AguiEvent> {
    if (!this.currentMessageId) return;
    yield { type: 'TEXT_MESSAGE_END', messageId: this.currentMessageId };
    this.currentMessageId = undefined;
    this.currentSourceMessageId = undefined;
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
    // Hand the floor back before finishing: a sub-agent left open would leave
    // the Portal showing a specialist still working after the run ended. If the
    // run failed while a specialist held the floor, say so on that specialist.
    const failure = this.mapStatus() === 'failed' ? (this.errorMessage ?? 'run failed') : undefined;
    while (this.subagentStack.length > 0) {
      for (const event of this.endSubagent(undefined, failure)) {
        yield attribute(event, this.currentSubagentRunId);
      }
    }

    for (const toolCallId of this.openToolCalls) {
      yield { type: 'TOOL_CALL_END', toolCallId };
    }
    this.openToolCalls.clear();

    // Anything the plan filter was holding back is ordinary text after all.
    const held = this.planFilter.flush();
    if (held && this.currentSourceMessageId) {
      yield* this.emitDisplayText(this.currentSourceMessageId, held);
    }

    yield* this.closeOpenMessage();

    this.settlePlan();
    const result = this.buildResult();
    const state: RunSharedState = { result };
    if (this.plan) state.plan = this.plan.map((step) => ({ ...step }));

    yield { type: 'STEP_FINISHED', stepName: this.opts.card.name };
    yield { type: 'STATE_SNAPSHOT', snapshot: state };
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
