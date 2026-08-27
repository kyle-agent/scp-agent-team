import type { AgentResult, Evidence, Severity } from '@scp/contracts';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function ResultPanel({
  result,
  onFollowup,
}: {
  result: AgentResult;
  onFollowup: (text: string) => void;
}) {
  const findings = [...(result.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const evidenceById = new Map((result.evidence ?? []).map((e) => [e.id, e]));

  return (
    <div className="result">
      <header className="result__header">
        <span className={`badge badge--${result.status}`}>{result.status}</span>
        {typeof result.confidence === 'number' && (
          <span className="muted">confidence {(result.confidence * 100).toFixed(0)}%</span>
        )}
      </header>

      <p className="result__summary">{result.summary}</p>

      {findings.length > 0 && (
        <Section title={`Findings (${findings.length})`}>
          <ul className="findings">
            {findings.map((f) => (
              <li key={f.id} className="finding">
                <div className="finding__head">
                  <span className={`sev sev--${f.severity}`}>{f.severity}</span>
                  <span className="finding__title">{f.title}</span>
                </div>
                {f.detail && <p className="finding__detail">{f.detail}</p>}
                {f.evidence_refs && f.evidence_refs.length > 0 && (
                  <div className="finding__refs">
                    {f.evidence_refs.map((ref) => {
                      const evidence = evidenceById.get(ref);
                      return (
                        <a key={ref} href={`#evidence-${ref}`} className="chip">
                          {evidence ? evidence.label : ref}
                        </a>
                      );
                    })}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(result.evidence?.length ?? 0) > 0 && (
        <Section title={`Evidence (${result.evidence!.length})`}>
          <ul className="evidence">
            {result.evidence!.map((e) => (
              <EvidenceRow key={e.id} evidence={e} />
            ))}
          </ul>
        </Section>
      )}

      {(result.recommendations?.length ?? 0) > 0 && (
        <Section title="Recommendations">
          <ul className="recommendations">
            {result.recommendations!.map((r) => (
              <li key={r.id}>
                <div className="rec__action">
                  {r.action}
                  {r.risk && r.risk !== 'read-only' && (
                    <span className={`risk risk--${r.risk}`}>{r.risk}</span>
                  )}
                </div>
                {r.rationale && <p className="muted">{r.rationale}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(result.requested_capabilities?.length ?? 0) > 0 && (
        <Section title="Requested capabilities">
          <ul className="capabilities">
            {result.requested_capabilities!.map((c, i) => (
              <li key={`${c.capability}-${i}`}>
                <code>{c.capability}</code>
                {c.requires_approval && <span className="chip chip--warn">needs approval</span>}
                <pre>{JSON.stringify(c.parameters ?? {}, null, 2)}</pre>
                <p className="muted">
                  Not executed. Business and infra writes stay disabled until an ADR enables them
                  (Phase 3/4).
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(result.followups?.length ?? 0) > 0 && (
        <Section title="Follow-up">
          <div className="followups">
            {result.followups!.map((f) => (
              <button key={f} type="button" className="chip chip--action" onClick={() => onFollowup(f)}>
                {f}
              </button>
            ))}
          </div>
        </Section>
      )}

      <footer className="result__trace">
        <span>trace {result.trace.trace_id}</span>
        <span>run {result.trace.agent_run_id}</span>
      </footer>
    </div>
  );
}

function EvidenceRow({ evidence }: { evidence: Evidence }) {
  return (
    <li id={`evidence-${evidence.id}`} className="evidence__item">
      <details>
        <summary>
          <span className={`kind kind--${evidence.kind}`}>{evidence.kind}</span>
          <span className="evidence__label">{evidence.label}</span>
          {evidence.source && <span className="muted">via {evidence.source}</span>}
        </summary>
        {evidence.content && <pre>{evidence.content}</pre>}
        {evidence.url && (
          <a href={evidence.url} target="_blank" rel="noreferrer noopener">
            {evidence.url}
          </a>
        )}
      </details>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="result__section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
