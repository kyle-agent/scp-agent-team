import type { AgentResult, PendingInput, PlanStep } from '@scp/contracts';
import type { AguiEvent } from './agui-events';

export type Phase =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_input';

interface ItemBase {
  id: string;
  at: number;
  /** Nesting level: 0 is the agent the user invoked, deeper is a delegation. */
  depth: number;
}

export interface StepItem extends ItemBase {
  kind: 'step';
  name: string;
  status: 'running' | 'done';
}

export interface ToolItem extends ItemBase {
  kind: 'tool';
  name: string;
  args?: string;
  result?: string;
  status: 'running' | 'done';
}

export interface MessageItem extends ItemBase {
  kind: 'message';
  text: string;
  status: 'streaming' | 'done';
}

/** A delegation to another agent. Everything under it is that agent's work. */
export interface SubagentItem extends ItemBase {
  kind: 'subagent';
  name: string;
  description?: string;
  status: 'running' | 'done' | 'failed';
  error?: string;
}

/**
 * Anything the agent sent that is not plain text or a tool call.
 *
 * This is the extension seam: an A2UI payload would arrive as a CUSTOM event
 * named `a2ui` and become a CustomItem, which the UIBlock registry renders with
 * a real renderer instead of the JSON fallback. See docs/access-mode-agui.md.
 */
export interface CustomItem extends ItemBase {
  kind: 'custom';
  name: string;
  value: unknown;
}

export type TimelineItem =
  | StepItem
  | ToolItem
  | MessageItem
  | SubagentItem
  | CustomItem;

export interface RunState {
  phase: Phase;
  threadId?: string;
  runId?: string;
  /**
   * What the agent said it would do, from AG-UI shared state.
   *
   * Separate from `timeline` because it is the only thing that can show work
   * that has not happened yet - the timeline is append-only and reactive.
   */
  plan?: PlanStep[];
  timeline: TimelineItem[];
  /** Sub-agent runs currently holding the floor, outermost first. */
  activeSubagents: string[];
  /** Every agent that took part, in the order they first appeared. */
  participants: string[];
  /** What the agent is waiting for. Set only while the run is paused. */
  pendingInput?: PendingInput;
  /**
   * Set by the Portal just before answering a question.
   *
   * A resumed run is a new AG-UI run but the same piece of work, so the next
   * RUN_STARTED must extend the session rather than clear the screen the user
   * was just reading.
   */
  continuation?: boolean;
  answer: string;
  result?: AgentResult;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export const initialRunState: RunState = {
  phase: 'idle',
  timeline: [],
  activeSubagents: [],
  participants: [],
  answer: '',
};

function replace(
  timeline: TimelineItem[],
  id: string,
  update: (item: TimelineItem) => TimelineItem,
): TimelineItem[] {
  let found = false;
  const next = timeline.map((item) => {
    if (item.id !== id) return item;
    found = true;
    return update(item);
  });
  return found ? next : timeline;
}

/**
 * Item ids scoped to the run that produced them.
 *
 * Protocol ids - message ids, tool call ids - are only unique within a run, but
 * the timeline spans runs once a session resumes after a pause. Unscoped, a
 * resumed run reusing a tool call id would both collide as a list key and have
 * its updates land on the *previous* run's row.
 */
function scopedId(state: RunState, id: string): string {
  return `${state.runId ?? 'run'}:${id}`;
}

/** Omit that distributes over the union, instead of collapsing to shared keys. */
type WithoutDepth<T> = T extends unknown ? Omit<T, 'depth'> : never;

/** Appends an item at the depth of whichever agent currently holds the floor. */
function append(state: RunState, item: WithoutDepth<TimelineItem>): TimelineItem[] {
  return [...state.timeline, { ...item, depth: state.activeSubagents.length } as TimelineItem];
}

/** Pure reducer: AG-UI event stream -> renderable run state. */
export function applyEvent(state: RunState, event: AguiEvent): RunState {
  const at = event.timestamp ?? Date.now();

  switch (event.type) {
    case 'RUN_STARTED':
      return state.continuation
        ? {
            ...state,
            continuation: false,
            phase: 'running',
            threadId: event.threadId,
            runId: event.runId,
            // The question has been answered, so it is no longer pending; the
            // previous run's result is superseded by the one now being produced.
            pendingInput: undefined,
            result: undefined,
            error: undefined,
            endedAt: undefined,
          }
        : {
            ...initialRunState,
            phase: 'running',
            threadId: event.threadId,
            runId: event.runId,
            startedAt: at,
          };

    case 'STEP_STARTED':
      return {
        ...state,
        timeline: append(state, {
          kind: 'step',
          // Scoped to the run: a resumed run repeats the step name, and the
          // timeline it is appended to still holds the earlier one.
          id: scopedId(state, `step-${event.stepName}`),
          name: event.stepName,
          status: 'running',
          at,
        }),
      };

    case 'STEP_FINISHED':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, `step-${event.stepName}`), (item) => ({
          ...item,
          status: 'done',
        })),
      };

    case 'TEXT_MESSAGE_START':
      return {
        ...state,
        timeline: append(state, {
          kind: 'message',
          id: scopedId(state, event.messageId),
          text: '',
          status: 'streaming',
          at,
        }),
      };

    case 'TEXT_MESSAGE_CONTENT':
      return {
        ...state,
        answer: state.answer + event.delta,
        timeline: replace(state.timeline, scopedId(state, event.messageId), (item) =>
          item.kind === 'message' ? { ...item, text: item.text + event.delta } : item,
        ),
      };

    case 'TEXT_MESSAGE_END':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.messageId), (item) =>
          item.kind === 'message' ? { ...item, status: 'done' } : item,
        ),
      };

    case 'TOOL_CALL_START':
      return {
        ...state,
        timeline: append(state, {
          kind: 'tool',
          id: scopedId(state, event.toolCallId),
          name: event.toolCallName,
          status: 'running',
          at,
        }),
      };

    case 'TOOL_CALL_ARGS':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.toolCallId), (item) =>
          item.kind === 'tool' ? { ...item, args: (item.args ?? '') + event.delta } : item,
        ),
      };

    case 'TOOL_CALL_END':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.toolCallId), (item) =>
          // A tool is only "done" once its result lands; END just closes the args.
          item.kind === 'tool' && item.result !== undefined
            ? { ...item, status: 'done' }
            : item,
        ),
      };

    case 'TOOL_CALL_RESULT':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.toolCallId), (item) =>
          item.kind === 'tool'
            ? { ...item, result: event.content, status: 'done' }
            : item,
        ),
      };

    case 'STATE_SNAPSHOT':
      return {
        ...state,
        plan: event.snapshot?.plan ?? state.plan,
        result: event.snapshot?.result ?? state.result,
        pendingInput: event.snapshot?.pendingInput ?? state.pendingInput,
      };

    case 'SUBAGENT_STARTED':
      return {
        ...state,
        // Appended at the parent's depth; its own work nests one level deeper.
        timeline: append(state, {
          kind: 'subagent',
          id: scopedId(state, event.subagentRunId),
          name: event.name,
          description: event.description,
          status: 'running',
          at,
        }),
        activeSubagents: [...state.activeSubagents, event.subagentRunId],
        participants: state.participants.includes(event.name)
          ? state.participants
          : [...state.participants, event.name],
      };

    case 'SUBAGENT_FINISHED':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.subagentRunId), (item) =>
          item.kind === 'subagent' ? { ...item, status: 'done' } : item,
        ),
        activeSubagents: state.activeSubagents.filter((id) => id !== event.subagentRunId),
      };

    case 'SUBAGENT_ERROR':
      return {
        ...state,
        timeline: replace(state.timeline, scopedId(state, event.subagentRunId), (item) =>
          item.kind === 'subagent' ? { ...item, status: 'failed', error: event.message } : item,
        ),
        activeSubagents: state.activeSubagents.filter((id) => id !== event.subagentRunId),
      };

    case 'CUSTOM':
      return {
        ...state,
        timeline: append(state, {
          kind: 'custom',
          id: scopedId(state, `custom-${state.timeline.length}`),
          name: event.name,
          value: event.value,
          at,
        }),
      };

    case 'RUN_ERROR':
      return { ...state, phase: 'failed', error: event.message, endedAt: at };

    case 'RUN_FINISHED': {
      const result = event.result ?? state.result;
      // A RUN_ERROR earlier in the stream already decided the outcome; do not
      // let the terminal RUN_FINISHED paper over it.
      const phase: Phase =
        state.phase === 'failed'
          ? 'failed'
          : result?.status === 'cancelled'
            ? 'cancelled'
            : result?.status === 'failed'
              ? 'failed'
              : result?.status === 'needs_input'
                ? 'needs_input'
                : 'completed';
      return {
        ...state,
        phase,
        result,
        endedAt: at,
        activeSubagents: [],
        timeline: state.timeline.map((item) =>
          item.kind === 'subagent' && item.status === 'running'
            ? { ...item, status: 'done' }
            : item,
        ),
      };
    }

    default:
      return state;
  }
}
