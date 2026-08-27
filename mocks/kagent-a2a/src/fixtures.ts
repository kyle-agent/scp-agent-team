export interface ScriptStep {
  /** Streamed as assistant text. */
  text?: string;
  /**
   * Streamed as a `[PLAN]` block inside the text stream, character by character.
   *
   * This is the path a real kagent agent takes: most can only emit text, so the
   * adapter has to recover the plan from it - including when the markers get
   * split across chunks.
   */
  planText?: string;
  /** Emitted as a structured plan DataPart, for agents that can send one. */
  planData?: { id?: string; label: string; tool?: string }[];
  /** Emitted as a plan-step status update. */
  planStep?: { id: string; status: string; detail?: string };
  /** Emitted as a tool call, then its result. */
  tool?: { name: string; args: Record<string, unknown>; result: unknown };
  /**
   * Hands the floor to another agent, runs its steps, then hands it back.
   *
   * Emitted as a `transfer_to_agent` call and its matching result, which is how
   * a delegating agent looks on the wire.
   */
  delegate?: { agent: string; task: string; steps: ScriptStep[]; result: unknown };
  delayMs?: number;
}

export interface Fixture {
  steps: ScriptStep[];
  /** Emitted as an artifact conforming to agent-result.schema.json. */
  result: Record<string, unknown>;
}

export const fixtures: Record<string, Fixture> = {
  'architecture-agent': {
    steps: [
      {
        planData: [
          { id: 'std', label: 'Find the applicable SCP standards', tool: 'knowledge_search' },
          { id: 'compare', label: 'Compare the design against them' },
          { id: 'gaps', label: 'Report gaps and recommendations' },
        ],
      },
      { text: 'Looking up the SCP architecture standards that apply here.\n\n' },
      {
        tool: {
          name: 'knowledge_search',
          args: { query: 'async ingestion service standard', top_k: 3 },
          result: {
            hits: [
              { doc: 'SCP-ARCH-014 Event-driven Service Standard', score: 0.91 },
              { doc: 'SCP-ARCH-007 Service Boundary Checklist', score: 0.84 },
              { doc: 'SCP-SEC-003 Data Classification', score: 0.71 },
            ],
          },
        },
        delayMs: 350,
      },
      {
        text:
          'The design matches the approved event-driven pattern in SCP-ARCH-014, ' +
          'but two required considerations are missing.\n\n',
        delayMs: 250,
      },
      {
        text:
          '- No dead-letter topic is defined for the ingestion consumer.\n' +
          '- Data classification is unstated, so retention cannot be validated.\n',
        delayMs: 250,
      },
      { planStep: { id: 'compare', status: 'done' } },
      { planStep: { id: 'gaps', status: 'done' } },
    ],
    result: {
      status: 'completed',
      summary:
        'Design conforms to SCP-ARCH-014 (event-driven services) with two gaps: no dead-letter handling and undeclared data classification.',
      findings: [
        {
          id: 'f-1',
          title: 'No dead-letter topic for the ingestion consumer',
          severity: 'high',
          category: 'gap',
          detail:
            'SCP-ARCH-014 §4.2 requires a DLQ for every at-least-once consumer so poison messages cannot block the partition.',
          evidence_refs: ['ev-std-1'],
        },
        {
          id: 'f-2',
          title: 'Data classification not declared',
          severity: 'medium',
          category: 'gap',
          detail:
            'SCP-SEC-003 requires a classification label before retention and encryption requirements can be derived.',
          evidence_refs: ['ev-std-2'],
        },
      ],
      evidence: [
        {
          id: 'ev-std-1',
          kind: 'document',
          label: 'SCP-ARCH-014 Event-driven Service Standard §4.2',
          source: 'knowledge_search',
          content:
            'Every consumer using at-least-once delivery MUST define a dead-letter topic and an operational runbook for draining it.',
        },
        {
          id: 'ev-std-2',
          kind: 'document',
          label: 'SCP-SEC-003 Data Classification §2',
          source: 'knowledge_search',
          content:
            'Services MUST declare the highest classification of data they persist. Retention and encryption requirements derive from it.',
        },
      ],
      recommendations: [
        {
          id: 'r-1',
          action: 'Add a dead-letter topic plus an alert on its depth.',
          rationale: 'Required by SCP-ARCH-014 §4.2; prevents partition stalls.',
          risk: 'read-only',
        },
        {
          id: 'r-2',
          action: 'Declare the data classification in the service manifest.',
          rationale: 'Unblocks retention and encryption review.',
          risk: 'read-only',
        },
      ],
      followups: [
        'Should the DLQ drain be automated as an Argo runbook?',
        'Which team owns the retention policy for this data?',
      ],
      confidence: 0.82,
    },
  },

  'k8s-agent': {
    steps: [
      {
        planText: [
          '[PLAN]',
          '- [ ] Check pod status (kubernetes_read)',
          '- [ ] Check recent deployments (kubernetes_read)',
          '- [ ] Analyse latency and saturation (prometheus_query)',
          '- [ ] Check network path (kubernetes_read)',
          '[/PLAN]',
          '',
        ].join('\n'),
      },
      { text: 'Checking workload health in the target namespace.\n\n' },
      {
        tool: {
          name: 'kubernetes_read',
          args: { verb: 'list', resource: 'pods', namespace: 'checkout' },
          result: {
            pods: [
              { name: 'checkout-7d9f-2xk4', ready: '1/1', restarts: 0, status: 'Running' },
              { name: 'checkout-7d9f-8lm2', ready: '1/1', restarts: 0, status: 'Running' },
              { name: 'checkout-7d9f-q4rt', ready: '1/1', restarts: 6, status: 'Running' },
            ],
          },
        },
        delayMs: 300,
      },
      {
        tool: {
          name: 'kubernetes_read',
          args: { verb: 'list', resource: 'deployments', namespace: 'checkout' },
          result: {
            deployments: [
              { name: 'checkout', ready: '3/3', updated: '19m ago', image: 'checkout:1.42.0' },
            ],
          },
        },
        delayMs: 250,
      },
      { text: 'Pods are up, but one has restarted 6 times. Checking latency.\n\n', delayMs: 200 },
      {
        tool: {
          name: 'prometheus_query',
          args: {
            query:
              'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{service="checkout"}[5m])) by (le))',
          },
          result: { value: 2.41, unit: 's', baseline: 0.28 },
        },
        delayMs: 400,
      },
      {
        tool: {
          name: 'prometheus_query',
          args: { query: 'sum(db_connection_pool_in_use{service="checkout"}) / sum(db_connection_pool_size{service="checkout"})' },
          result: { value: 0.99, note: 'pool saturated for 18 minutes' },
        },
        delayMs: 350,
      },
      {
        text:
          'p95 latency is 2.41s against a 0.28s baseline, and the DB connection pool has been at 99% for 18 minutes. ' +
          'That saturation is the bottleneck, not CPU or memory.\n',
        delayMs: 250,
      },
      {
        // Delegation: the Kubernetes Agent cannot see the service mesh, so it
        // hands that step to a specialist and reports what came back.
        delegate: {
          agent: 'network_diagnostics',
          task: 'Confirm the checkout pods can reach the database, and report added latency on the path.',
          steps: [
            { text: 'Tracing the path from checkout to the database.\n\n', delayMs: 150 },
            {
              tool: {
                name: 'kubernetes_read',
                args: { verb: 'get', resource: 'networkpolicy', namespace: 'checkout' },
                result: { policies: ['allow-db-egress'], blocked: false },
              },
              delayMs: 250,
            },
            {
              tool: {
                name: 'prometheus_query',
                args: { query: 'histogram_quantile(0.95, rate(envoy_tcp_connect_ms_bucket{app="checkout"}[5m]))' },
                result: { value: 3.1, unit: 'ms', note: 'nominal' },
              },
              delayMs: 300,
            },
            {
              text: 'Network path is clean: policy permits egress and connect latency is 3.1ms.\n',
              delayMs: 200,
            },
          ],
          result: {
            verdict: 'network_healthy',
            connect_p95_ms: 3.1,
            note: 'No policy blocks; latency is not introduced on the network path.',
          },
        },
      },
      {
        text:
          'The Network Diagnostics agent ruled out the network path, which leaves the ' +
          'connection pool as the sole explanation.\n',
        delayMs: 200,
      },
    ],
    result: {
      status: 'completed',
      summary:
        'checkout p95 latency is 2.41s (baseline 0.28s). Root cause is DB connection pool saturation at 99% for 18 minutes, not compute pressure.',
      findings: [
        {
          id: 'f-1',
          title: 'DB connection pool saturation',
          severity: 'critical',
          category: 'root_cause',
          detail:
            'in_use/size has sat at 0.99 for 18 minutes. Requests queue waiting for a connection, which shows up as request latency.',
          evidence_refs: ['ev-2', 'ev-3'],
        },
        {
          id: 'f-2',
          title: 'Pod checkout-7d9f-q4rt restarted 6 times',
          severity: 'medium',
          category: 'observation',
          detail:
            'Restarts correlate with the latency window; likely liveness probe timeouts caused by the same saturation.',
          evidence_refs: ['ev-1'],
        },
      ],
      evidence: [
        {
          id: 'ev-1',
          kind: 'command_output',
          label: 'kubectl get pods -n checkout',
          source: 'kubernetes_read',
          content:
            'checkout-7d9f-2xk4   1/1   Running   0\ncheckout-7d9f-8lm2   1/1   Running   0\ncheckout-7d9f-q4rt   1/1   Running   6',
        },
        {
          id: 'ev-2',
          kind: 'metric',
          label: 'p95 request duration',
          source: 'prometheus_query',
          content: '2.41s (baseline 0.28s)',
        },
        {
          id: 'ev-3',
          kind: 'metric',
          label: 'DB connection pool utilisation',
          source: 'prometheus_query',
          content: '0.99 sustained for 18 minutes',
        },
      ],
      recommendations: [
        {
          id: 'r-1',
          action: 'Raise the connection pool ceiling for checkout and re-measure p95.',
          rationale: 'Directly relieves the observed saturation.',
          risk: 'infra-write',
        },
        {
          id: 'r-2',
          action: 'Relax the liveness probe timeout so saturation does not cause restarts.',
          rationale: 'Restarts compound the incident by shedding warm connections.',
          risk: 'infra-write',
        },
      ],
      requested_capabilities: [
        {
          capability: 'createIncident',
          parameters: { service: 'checkout', severity: 'SEV2', summary: 'DB pool saturation' },
          requires_approval: true,
        },
      ],
      followups: [
        'Did a recent deployment change the pool size?',
        'Is the database itself connection-limited?',
      ],
      confidence: 0.88,
    },
  },
};

export const defaultFixture: Fixture = {
  steps: [{ text: 'Mock agent has no scripted fixture for this agent name.\n' }],
  result: {
    status: 'completed',
    summary: 'Mock response. Add a fixture in mocks/kagent-a2a/src/fixtures.ts.',
    findings: [],
    evidence: [],
    recommendations: [],
  },
};
