/**
 * AG-UI event vocabulary (the subset this adapter emits) and the SSE encoding.
 *
 * Field names follow the AG-UI spec exactly so an off-the-shelf @ag-ui/client
 * can consume this stream without translation.
 */

export const EventType = {
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  SUBAGENT_STARTED: 'SUBAGENT_STARTED',
  SUBAGENT_FINISHED: 'SUBAGENT_FINISHED',
  SUBAGENT_ERROR: 'SUBAGENT_ERROR',
  CUSTOM: 'CUSTOM',
} as const;

export type EventTypeName = (typeof EventType)[keyof typeof EventType];

interface Base {
  type: EventTypeName;
  timestamp?: number;
  /**
   * Which sub-agent produced this event.
   *
   * Absent means the agent the user invoked. Run-level events never carry it -
   * a run belongs to the whole collaboration, not to one participant.
   */
  subagentRunId?: string;
}

export type AguiEvent =
  | (Base & { type: 'RUN_STARTED'; threadId: string; runId: string })
  | (Base & { type: 'RUN_FINISHED'; threadId: string; runId: string; result?: unknown })
  | (Base & { type: 'RUN_ERROR'; message: string; code?: string })
  | (Base & { type: 'STEP_STARTED'; stepName: string })
  | (Base & { type: 'STEP_FINISHED'; stepName: string })
  | (Base & { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' })
  | (Base & { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string })
  | (Base & { type: 'TEXT_MESSAGE_END'; messageId: string })
  | (Base & {
      type: 'TOOL_CALL_START';
      toolCallId: string;
      toolCallName: string;
      parentMessageId?: string;
    })
  | (Base & { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string })
  | (Base & { type: 'TOOL_CALL_END'; toolCallId: string })
  | (Base & {
      type: 'TOOL_CALL_RESULT';
      messageId: string;
      toolCallId: string;
      content: string;
      role?: 'tool';
    })
  | (Base & { type: 'STATE_SNAPSHOT'; snapshot: unknown })
  | (Base & {
      type: 'SUBAGENT_STARTED';
      subagentRunId: string;
      name: string;
      description?: string;
      parentSubagentRunId?: string;
      parentToolCallId?: string;
      parentMessageId?: string;
    })
  | (Base & { type: 'SUBAGENT_FINISHED'; subagentRunId: string; result?: unknown; outcome?: string })
  | (Base & { type: 'SUBAGENT_ERROR'; subagentRunId: string; message: string; code?: string })
  | (Base & { type: 'CUSTOM'; name: string; value: unknown });

/** Events that describe the run as a whole, so they are never attributed to one participant. */
const UNATTRIBUTED: ReadonlySet<string> = new Set([
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'SUBAGENT_ERROR',
]);

/** Tags an event with the sub-agent that produced it, where that is meaningful. */
export function attribute(event: AguiEvent, subagentRunId?: string): AguiEvent {
  if (!subagentRunId || UNATTRIBUTED.has(event.type) || event.subagentRunId) return event;
  return { ...event, subagentRunId };
}

export function stamp(event: AguiEvent): AguiEvent {
  return { ...event, timestamp: event.timestamp ?? Date.now() };
}

/** One AG-UI event as an SSE frame. */
export function encodeSse(event: AguiEvent): string {
  return `data: ${JSON.stringify(stamp(event))}\n\n`;
}
