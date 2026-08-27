import type { CustomItem } from '../lib/run-state';

/**
 * Renderer registry for agent-sent payloads that are not text or tool calls.
 *
 * Today every CUSTOM event falls through to the JSON inspector. This indirection
 * exists so a declarative-UI format (A2UI is the likely one) can be adopted
 * later by registering a renderer here - the adapter, the transport and the
 * timeline stay untouched. See ADR-009 in docs/architecture.md.
 */
type Renderer = (value: unknown) => JSX.Element;

const renderers: Record<string, Renderer> = {
  // 'a2ui': (value) => <A2uiRenderer spec={value} />,   <- the future plug point
};

export function UIBlock({ item }: { item: CustomItem }) {
  const renderer = renderers[item.name];
  if (renderer) return renderer(item.value);

  return (
    <details className="ui-block">
      <summary>
        <span className="ui-block__name">{item.name}</span>
        <span className="ui-block__hint">no renderer registered - raw payload</span>
      </summary>
      <pre>{stringify(item.value)}</pre>
    </details>
  );
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
