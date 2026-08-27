import { readSseData } from './sse.js';

/** A2A wire types - only the fields this adapter reads. */
export interface A2ATextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}
export interface A2ADataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
export type A2APart = A2ATextPart | A2ADataPart | { kind: string; [k: string]: unknown };

export interface A2AMessage {
  kind?: 'message';
  role: 'user' | 'agent';
  messageId: string;
  parts: A2APart[];
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state:
    | 'submitted'
    | 'working'
    | 'input-required'
    | 'completed'
    | 'canceled'
    | 'failed'
    | 'rejected'
    | 'unknown';
  message?: A2AMessage;
  timestamp?: string;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  kind: 'task';
  id: string;
  contextId: string;
  status: A2ATaskStatus;
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
}

export interface A2AStatusUpdate {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: A2ATaskStatus;
  final?: boolean;
  metadata?: Record<string, unknown>;
}

export interface A2AArtifactUpdate {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
}

export type A2AStreamResult =
  | A2AMessage
  | A2ATask
  | A2AStatusUpdate
  | A2AArtifactUpdate;

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: A2AStreamResult;
  error?: { code: number; message: string; data?: unknown };
}

export class A2AError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'A2AError';
  }
}

export interface A2AStreamOptions {
  baseUrl: string;
  namespace: string;
  agentName: string;
  text: string;
  /** Carries the Portal session so kagent keeps conversation context across follow-ups. */
  contextId?: string;
  taskId?: string;
  messageId: string;
  metadata?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export function agentUrl(baseUrl: string, namespace: string, agentName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/a2a/${encodeURIComponent(namespace)}/${encodeURIComponent(agentName)}/`;
}

/**
 * Calls kagent's A2A `message/stream` and yields each JSON-RPC result as it arrives.
 *
 * kagent exposes every agent over A2A on the controller's port 8083 at
 * `/api/a2a/{namespace}/{agent}/`, so this one client reaches any shared agent
 * without per-agent code.
 */
export async function* streamMessage(
  opts: A2AStreamOptions,
): AsyncGenerator<A2AStreamResult> {
  const url = agentUrl(opts.baseUrl, opts.namespace, opts.agentName);
  const body = {
    jsonrpc: '2.0' as const,
    id: opts.messageId,
    method: 'message/stream',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: opts.messageId,
        parts: [{ kind: 'text', text: opts.text }],
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
      },
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...opts.headers,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    throw new A2AError(
      `cannot reach kagent at ${url}: ${(err as Error).message}`,
      'KAGENT_UNREACHABLE',
    );
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new A2AError(
      `kagent returned ${response.status} for ${url}${detail ? `: ${detail}` : ''}`,
      response.status === 401 || response.status === 403
        ? 'KAGENT_UNAUTHORIZED'
        : 'KAGENT_ERROR',
    );
  }
  if (!response.body) {
    throw new A2AError(`kagent returned an empty body for ${url}`, 'KAGENT_ERROR');
  }

  for await (const data of readSseData(response.body, opts.signal)) {
    if (data === '[DONE]') break;
    let parsed: A2AJsonRpcResponse;
    try {
      parsed = JSON.parse(data) as A2AJsonRpcResponse;
    } catch {
      // A malformed frame should not kill an otherwise healthy run.
      continue;
    }
    if (parsed.error) {
      throw new A2AError(parsed.error.message, `A2A_${parsed.error.code}`);
    }
    if (parsed.result) yield parsed.result;
  }
}
