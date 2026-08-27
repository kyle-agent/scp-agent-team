import type { RunState, TimelineItem } from '../lib/run-state';
import { UIBlock } from './UIBlock';

export function Timeline({ state }: { state: RunState }) {
  if (state.timeline.length === 0) {
    return (
      <div className="empty">
        {state.phase === 'running'
          ? 'Waiting for the agent…'
          : 'Run an agent to see its live timeline, tool activity and evidence.'}
      </div>
    );
  }

  return (
    <ol className="timeline">
      {state.timeline.map((item) => (
        <li key={item.id} className={`timeline__item timeline__item--${item.kind}`}>
          <Row item={item} />
        </li>
      ))}
    </ol>
  );
}

function Row({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'step':
      return (
        <div className="step">
          <StatusDot status={item.status === 'done' ? 'done' : 'running'} />
          <span className="step__name">{item.name}</span>
          <span className="muted">{item.status === 'done' ? 'finished' : 'working'}</span>
        </div>
      );

    case 'message':
      return (
        <div className="message">
          <div className="message__text">
            {item.text}
            {item.status === 'streaming' && <span className="caret" />}
          </div>
        </div>
      );

    case 'tool':
      return (
        <details className="tool" open={item.status === 'running'}>
          <summary>
            <StatusDot status={item.status === 'done' ? 'done' : 'running'} />
            <code className="tool__name">{item.name}</code>
            <span className="muted">
              {item.status === 'done' ? 'returned' : 'calling…'}
            </span>
          </summary>
          {item.args && (
            <div className="tool__section">
              <div className="tool__label">arguments</div>
              <pre>{pretty(item.args)}</pre>
            </div>
          )}
          {item.result !== undefined && (
            <div className="tool__section">
              <div className="tool__label">result</div>
              <pre>{pretty(item.result)}</pre>
            </div>
          )}
        </details>
      );

    case 'custom':
      return <UIBlock item={item} />;
  }
}

function StatusDot({ status }: { status: 'running' | 'done' }) {
  return <span className={`dot dot--${status}`} aria-hidden="true" />;
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
