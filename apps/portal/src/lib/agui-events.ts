import type { AgentResult, RunSharedState } from '@scp/contracts';

/** Mirrors the adapter's emitted AG-UI event set (apps/agui-adapter/src/agui/events.ts). */
export type AguiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string; timestamp?: number }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string; result?: AgentResult; timestamp?: number }
  | { type: 'RUN_ERROR'; message: string; code?: string; timestamp?: number }
  | { type: 'STEP_STARTED'; stepName: string; timestamp?: number }
  | { type: 'STEP_FINISHED'; stepName: string; timestamp?: number }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant'; timestamp?: number }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string; timestamp?: number }
  | { type: 'TEXT_MESSAGE_END'; messageId: string; timestamp?: number }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string; parentMessageId?: string; timestamp?: number }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string; timestamp?: number }
  | { type: 'TOOL_CALL_END'; toolCallId: string; timestamp?: number }
  | { type: 'TOOL_CALL_RESULT'; messageId: string; toolCallId: string; content: string; role?: 'tool'; timestamp?: number }
  | { type: 'STATE_SNAPSHOT'; snapshot: RunSharedState; timestamp?: number }
  | { type: 'CUSTOM'; name: string; value: unknown; timestamp?: number };
