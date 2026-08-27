import type { PlanStep, PlanStepStatus } from '@scp/contracts';

const MARK: Record<PlanStepStatus, string> = {
  done: '✓',
  running: '●',
  pending: '○',
  skipped: '⊘',
  failed: '✕',
};

const LABEL: Record<PlanStepStatus, string> = {
  done: 'done',
  running: 'in progress',
  pending: 'planned',
  skipped: 'skipped',
  failed: 'failed',
};

/**
 * The agent's declared plan.
 *
 * This is the one part of the screen that can show work that has not started.
 * It exists only when the agent declared a plan; without one the timeline still
 * shows everything that happened, just not what is coming.
 */
export function PlanChecklist({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === 'done').length;

  return (
    <div className="plan">
      <div className="plan__head">
        <h2>Plan</h2>
        <span className="muted">
          {done}/{steps.length} done
        </span>
      </div>
      <ol className="plan__list">
        {steps.map((step) => (
          <li key={step.id} className={`plan__step plan__step--${step.status}`}>
            <span className="plan__mark" aria-hidden="true">
              {MARK[step.status]}
            </span>
            <span className="plan__label">
              {/* The label alone carries the strikethrough when a step is
                  skipped - text-decoration cannot be cancelled on descendants,
                  so the reason has to sit outside it. */}
              <span className="plan__text">{step.label}</span>
              {step.tool && <code className="plan__tool">{step.tool}</code>}
              {step.detail && <span className="plan__detail">{step.detail}</span>}
            </span>
            <span className="plan__status muted">{LABEL[step.status]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
