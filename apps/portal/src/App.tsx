import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentCard } from '@scp/contracts';
import { cancelRun, fetchAgents, runAgent } from './lib/client';
import { applyEvent, initialRunState, type RunState } from './lib/run-state';
import { Timeline } from './components/Timeline';
import { PlanChecklist } from './components/PlanChecklist';
import { ResultPanel } from './components/ResultPanel';

function newId(): string {
  return crypto.randomUUID();
}

export function App() {
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [agentId, setAgentId] = useState<string>('');
  const [task, setTask] = useState('');
  const [service, setService] = useState('');
  const [environment, setEnvironment] = useState('prod');
  const [manifest, setManifest] = useState('');
  const [state, setState] = useState<RunState>(initialRunState);

  // One thread per browser session, so kagent keeps context across follow-ups.
  const threadId = useMemo(() => newId(), []);
  const abortRef = useRef<AbortController>();
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAgents()
      .then((list) => {
        setAgents(list);
        setAgentId((current) => current || list[0]?.id || '');
      })
      .catch((err: Error) => setCatalogError(err.message));
  }, []);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [state.timeline]);

  const selected = agents.find((a) => a.id === agentId);
  const running = state.phase === 'running';

  const start = useCallback(
    async (taskText: string) => {
      if (!agentId || !taskText.trim() || running) return;

      const controller = new AbortController();
      abortRef.current = controller;
      const runId = newId();
      setState({ ...initialRunState, phase: 'running', runId, threadId });

      try {
        const stream = runAgent(
          {
            agent: agentId,
            task: taskText,
            threadId,
            runId,
            context: {
              ...(service ? { service } : {}),
              ...(environment ? { environment } : {}),
            },
            artifacts: manifest.trim()
              ? [{ name: 'manifest.yaml', media_type: 'application/yaml', content: manifest }]
              : undefined,
          },
          controller.signal,
        );
        for await (const event of stream) {
          setState((prev) => applyEvent(prev, event));
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setState((prev) => ({ ...prev, phase: 'cancelled', endedAt: Date.now() }));
        } else {
          setState((prev) => ({
            ...prev,
            phase: 'failed',
            error: (err as Error).message,
            endedAt: Date.now(),
          }));
        }
      } finally {
        abortRef.current = undefined;
      }
    },
    [agentId, environment, manifest, running, service, threadId],
  );

  const stop = useCallback(() => {
    if (state.runId) void cancelRun(state.runId);
    abortRef.current?.abort();
  }, [state.runId]);

  const onFollowup = useCallback(
    (text: string) => {
      setTask(text);
      void start(text);
    },
    [start],
  );

  // The three actions the intro deck calls for. All three continue the same
  // thread, so kagent keeps the conversation context rather than starting cold.
  const analyseFurther = useCallback(() => {
    const text =
      'Go deeper on the leading root cause: what else would confirm or rule it out?';
    setTask(text);
    void start(text);
  }, [start]);

  const otherHypotheses = useCallback(() => {
    const text =
      'What other explanations could produce these symptoms? Rank them and say what would distinguish each.';
    setTask(text);
    void start(text);
  }, [start]);

  const endSession = useCallback(() => {
    setState(initialRunState);
    setTask('');
  }, []);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>SCP Agent Team</h1>
          <p className="muted">
            Direct user access · AG-UI over kagent · the same shared agents your local
            agent reaches over MCP
          </p>
        </div>
        <div className="app__phase">
          <span className={`badge badge--${state.phase}`}>{state.phase}</span>
          {state.startedAt && state.endedAt && (
            <span className="muted">{((state.endedAt - state.startedAt) / 1000).toFixed(1)}s</span>
          )}
        </div>
      </header>

      <main className="app__body">
        <aside className="panel panel--form">
          <h2>Run</h2>

          {catalogError && <div className="error">Agent catalog unavailable: {catalogError}</div>}

          <label>
            <span>Agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              disabled={running || agents.length === 0}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <div className="agent-card">
              <p>{selected.description}</p>
              <div className="agent-card__meta">
                <span className={`risk risk--${selected.risk_level}`}>{selected.risk_level}</span>
                {selected.tools.map((t) => (
                  <code key={t}>{t}</code>
                ))}
              </div>
            </div>
          )}

          <label>
            <span>Task</span>
            <textarea
              rows={5}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={selected?.example_tasks?.[0] ?? 'What should this agent do?'}
              disabled={running}
            />
          </label>

          {selected?.example_tasks && (
            <div className="examples">
              {selected.example_tasks.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip chip--action"
                  onClick={() => setTask(example)}
                  disabled={running}
                >
                  {example}
                </button>
              ))}
            </div>
          )}

          <div className="row">
            <label>
              <span>Service</span>
              <input
                value={service}
                onChange={(e) => setService(e.target.value)}
                placeholder="checkout"
                disabled={running}
              />
            </label>
            <label>
              <span>Environment</span>
              <input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                disabled={running}
              />
            </label>
          </div>

          <label>
            <span>Artifact (optional manifest / design)</span>
            <textarea
              rows={4}
              value={manifest}
              onChange={(e) => setManifest(e.target.value)}
              placeholder="apiVersion: apps/v1&#10;kind: Deployment&#10;..."
              disabled={running}
              spellCheck={false}
            />
          </label>

          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void start(task)}
              disabled={running || !task.trim() || !agentId}
            >
              {running ? 'Running…' : 'Run agent'}
            </button>
            <button type="button" className="btn" onClick={stop} disabled={!running}>
              Cancel
            </button>
          </div>
        </aside>

        <section className="panel panel--timeline" ref={timelineRef}>
          {state.error && <div className="error">{state.error}</div>}
          {state.plan && state.plan.length > 0 && <PlanChecklist steps={state.plan} />}
          <h2>Timeline</h2>
          <Timeline state={state} />
        </section>

        <section className="panel panel--result">
          <h2>Result</h2>
          {state.result ? (
            <>
              <ResultPanel result={state.result} onFollowup={onFollowup} />
              <div className="session-actions">
                <button type="button" className="btn" onClick={analyseFurther} disabled={running}>
                  Analyse further
                </button>
                <button type="button" className="btn" onClick={otherHypotheses} disabled={running}>
                  Other hypotheses
                </button>
                <button type="button" className="btn" onClick={endSession} disabled={running}>
                  End
                </button>
              </div>
            </>
          ) : (
            <div className="empty">
              Findings, evidence and recommendations appear here when the run completes.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
