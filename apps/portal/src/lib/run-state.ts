import type { AgentResult, PlanStep } from '@scp/contracts';
import type { AguiEvent } from './agui-events';

export type Phase = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface StepItem {
  kind: 'step';
  id: string;
  name: string;
  status: 'running' | 'done';
  at: number;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args?: string;
  result?: string;
  status: 'running' | 'done';
  at: number;
}

export interface MessageItem {
  kind: 'message';
  id: string;
  text: string;
  status: 'streaming' | 'done';
  at: number;
}

/**
 * Anything the agent sent that is not plain text or a tool call.
 *
 * This is the extension seam: an A2UI payload would arrive as a CUSTOM event
 * named `a2ui` and become a CustomItem, which the UIBlock registry renders with
 * a real renderer instead of the JSON fallback. See docs/access-mode-agui.md.
 */
export interface CustomItem {
  kind: 'custom';
  id: string;
  name: string;
  value: unknown;
  at: number;
}

export type TimelineItem = StepItem | ToolItem | MessageItem | CustomItem;

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
  answer: string;
  result?: AgentResult;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export const initialRunState: RunState = {
  phase: 'idle',
  timeline: [],
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

/** Pure reducer: AG-UI event stream -> renderable run state. */
export function applyEvent(state: RunState, event: AguiEvent): RunState {
  const at = event.timestamp ?? Date.now();

  switch (event.type) {
    case 'RUN_STARTED':
      return {
        ...initialRunState,
        phase: 'running',
        threadId: event.threadId,
        runId: event.runId,
        startedAt: at,
      };

    case 'STEP_STARTED':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'step', id: `step-${event.stepName}`, name: event.stepName, status: 'running', at },
        ],
      };

    case 'STEP_FINISHED':
      return {
        ...state,
        timeline: replace(state.timeline, `step-${event.stepName}`, (item) => ({
          ...item,
          status: 'done',
        })),
      };

    case 'TEXT_MESSAGE_START':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'message', id: event.messageId, text: '', status: 'streaming', at },
        ],
      };

    case 'TEXT_MESSAGE_CONTENT':
      return {
        ...state,
        answer: state.answer + event.delta,
        timeline: replace(state.timeline, event.messageId, (item) =>
          item.kind === 'message' ? { ...item, text: item.text + event.delta } : item,
        ),
      };

    case 'TEXT_MESSAGE_END':
      return {
        ...state,
        timeline: replace(state.timeline, event.messageId, (item) =>
          item.kind === 'message' ? { ...item, status: 'done' } : item,
        ),
      };

    case 'TOOL_CALL_START':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          {
            kind: 'tool',
            id: event.toolCallId,
            name: event.toolCallName,
            status: 'running',
            at,
          },
        ],
      };

    case 'TOOL_CALL_ARGS':
      return {
        ...state,
        timeline: replace(state.timeline, event.toolCallId, (item) =>
          item.kind === 'tool' ? { ...item, args: (item.args ?? '') + event.delta } : item,
        ),
      };

    case 'TOOL_CALL_END':
      return {
        ...state,
        timeline: replace(state.timeline, event.toolCallId, (item) =>
          // A tool is only "done" once its result lands; END just closes the args.
          item.kind === 'tool' && item.result !== undefined
            ? { ...item, status: 'done' }
            : item,
        ),
      };

    case 'TOOL_CALL_RESULT':
      return {
        ...state,
        timeline: replace(state.timeline, event.toolCallId, (item) =>
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
      };

    case 'CUSTOM':
      return {
        ...state,
        timeline: [
          ...state.timeline,
          { kind: 'custom', id: `custom-${state.timeline.length}`, name: event.name, value: event.value, at },
        ],
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
              : 'completed';
      return { ...state, phase, result, endedAt: at };
    }

    default:
      return state;
  }
}
