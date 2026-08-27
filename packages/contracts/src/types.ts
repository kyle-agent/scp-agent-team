/**
 * Shared contract types. These mirror the JSON Schemas in ../schemas and are the
 * single vocabulary used by every access mode (MCP today, AG-UI today, A2A later).
 */

export type RiskLevel = 'read-only' | 'business-write' | 'infra-write';
export type AccessMode = 'local-agent' | 'portal';

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  tools: string[];
  risk_level: RiskLevel;
  version: string;
  runtime: { kind: 'kagent'; namespace: string; name: string };
  blocked_tools?: string[];
  example_tasks?: string[];
}

export interface InvocationArtifact {
  name: string;
  media_type?: string;
  content: string;
}

export interface AgentInvocation {
  request_id: string;
  agent: string;
  task: string;
  context?: {
    project?: string;
    service?: string;
    environment?: string;
    namespace?: string;
    [k: string]: unknown;
  };
  artifacts?: InvocationArtifact[];
  constraints?: string[];
  actor: { type: AccessMode; user_id: string; client?: string };
  correlation: { trace_id: string; session_id?: string; parent_run_id?: string };
}

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type FindingCategory = 'root_cause' | 'risk' | 'gap' | 'observation';

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  /** `root_cause` marks a candidate explanation; the Portal lists those separately. */
  category?: FindingCategory;
  detail?: string;
  evidence_refs?: string[];
}

export type EvidenceKind =
  | 'metric'
  | 'log'
  | 'manifest'
  | 'document'
  | 'command_output'
  | 'link';

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  source?: string;
  content?: string;
  url?: string;
}

export interface Recommendation {
  id: string;
  action: string;
  rationale?: string;
  risk?: RiskLevel;
}

export interface RequestedCapability {
  capability: string;
  parameters?: Record<string, unknown>;
  requires_approval?: boolean;
}

export interface AgentResult {
  status: 'completed' | 'failed' | 'cancelled' | 'needs_input';
  summary: string;
  findings?: Finding[];
  evidence?: Evidence[];
  recommendations?: Recommendation[];
  requested_capabilities?: RequestedCapability[];
  followups?: string[];
  confidence?: number;
  trace: { trace_id: string; agent_run_id: string; request_id?: string };
  error?: { code: string; message: string };
}

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

/**
 * One step an agent intends to take.
 *
 * A plan is what makes "not started yet" renderable. Tool events can only say
 * what already happened, so without a declared plan a UI can show a running and
 * a finished step but never an upcoming one.
 */
export interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  /** The tool that carries out this step, if any. Used to advance it automatically. */
  tool?: string;
  detail?: string;
}

/**
 * AG-UI shared state for one run, carried by STATE_SNAPSHOT.
 *
 * Snapshots rather than STATE_DELTA patches: a plan is a handful of steps, so
 * resending it costs nothing measurable, and it keeps every AG-UI client working
 * without a JSON Patch implementation. Revisit if plans ever get large.
 */
export interface RunSharedState {
  plan?: PlanStep[];
  result?: AgentResult;
}

/** Audit record written for every invocation, in both access modes (SPEC §18). */
export interface AuditRecord {
  ts: string;
  trace_id: string;
  request_id: string;
  session_id?: string;
  user: string;
  access_mode: AccessMode;
  client?: string;
  agent: string;
  agent_run_id?: string;
  /** Every agent that took part, when the run involved more than the one invoked. */
  participants?: string[];
  tools: { tool_call_id: string; name: string; subagent?: string }[];
  duration_ms: number;
  status: string;
  error?: string;
}
