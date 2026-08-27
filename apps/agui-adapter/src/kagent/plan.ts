import type { PlanStep, PlanStepStatus } from '@scp/contracts';
import { checkRunPlan } from '@scp/contracts';
import type { A2APart } from './a2a.js';

export interface PlanDeclaration {
  kind: 'plan';
  steps: PlanStep[];
}
export interface PlanStepUpdate {
  kind: 'plan-step';
  id: string;
  status: PlanStepStatus;
  detail?: string;
}
export type PlanSignal = PlanDeclaration | PlanStepUpdate;

const STATUSES: PlanStepStatus[] = ['pending', 'running', 'done', 'skipped', 'failed'];

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Normalises a loosely-shaped step list into valid PlanSteps.
 *
 * Returns undefined rather than throwing: a malformed plan should cost the user
 * a checklist, never the run.
 */
export function normalizeSteps(raw: unknown): PlanStep[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const steps: PlanStep[] = [];
  raw.forEach((entry, index) => {
    const source =
      typeof entry === 'string' ? { label: entry } : (entry as Record<string, unknown>);
    if (!source || typeof source !== 'object') return;

    const label = str(source.label) ?? str(source.title) ?? str(source.name);
    if (!label) return;

    const status = str(source.status) as PlanStepStatus | undefined;
    steps.push({
      id: str(source.id) ?? `step-${index + 1}`,
      label,
      status: status && STATUSES.includes(status) ? status : 'pending',
      ...(str(source.tool) ? { tool: str(source.tool)! } : {}),
      ...(str(source.detail) ? { detail: str(source.detail)! } : {}),
    });
  });

  if (steps.length === 0) return undefined;
  // Deduplicate ids, which the agent controls and may repeat.
  const seen = new Set<string>();
  for (const step of steps) {
    let id = step.id;
    for (let n = 2; seen.has(id); n++) id = `${step.id}-${n}`;
    step.id = id;
    seen.add(id);
  }

  return checkRunPlan(steps).ok ? steps : undefined;
}

/** Recognises a plan declaration or a step update inside an A2A DataPart. */
export function detectPlanSignal(part: A2APart): PlanSignal | undefined {
  if (part.kind !== 'data') return undefined;
  const data = (part as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;

  const marker = (str(d.kind) ?? str(d.type) ?? '').toLowerCase().replace(/[-\s]/g, '_');

  if (marker === 'plan_step' || marker === 'step_update') {
    const id = str(d.id) ?? str(d.step_id) ?? str(d.stepId);
    const status = str(d.status) as PlanStepStatus | undefined;
    if (id && status && STATUSES.includes(status)) {
      return { kind: 'plan-step', id, status, ...(str(d.detail) ? { detail: str(d.detail)! } : {}) };
    }
    return undefined;
  }

  if (marker === 'plan' || Array.isArray(d.plan)) {
    const steps = normalizeSteps(d.plan ?? d.steps);
    return steps ? { kind: 'plan', steps } : undefined;
  }

  return undefined;
}

const OPEN = '[PLAN]';
const CLOSE = '[/PLAN]';

/**
 * Pulls a `[PLAN] ... [/PLAN]` block out of streamed assistant text.
 *
 * Most kagent agents can only emit text - custom DataParts depend on the
 * underlying framework - so this is what makes a declared plan reachable
 * without changing the agent's runtime. The block is removed from what the
 * Portal displays, so the plan renders as a checklist and not as prose.
 *
 * Text arrives in arbitrary chunks, so a trailing fragment that could still
 * become a marker is held back rather than emitted and regretted.
 */
export class PlanTextFilter {
  private inside = false;
  private buffered = '';
  private captured = '';

  /** Returns the text safe to display now, plus a plan once its block closes. */
  push(delta: string): { text: string; steps?: PlanStep[] } {
    this.buffered += delta;
    let display = '';
    let steps: PlanStep[] | undefined;

    for (;;) {
      if (!this.inside) {
        const start = this.buffered.indexOf(OPEN);
        if (start === -1) break;
        display += this.buffered.slice(0, start);
        this.buffered = this.buffered.slice(start + OPEN.length);
        this.inside = true;
        continue;
      }

      const end = this.buffered.indexOf(CLOSE);
      if (end === -1) break;
      this.captured += this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + CLOSE.length);
      this.inside = false;
      steps = parsePlanBlock(this.captured) ?? steps;
      this.captured = '';
    }

    // Hold back a trailing fragment that could still grow into the marker we are
    // looking for. Without this the marker is consumed as ordinary content and
    // the block never opens or never closes.
    const marker = this.inside ? CLOSE : OPEN;
    const hold = partialMarkerLength(this.buffered, marker);
    const settled = this.buffered.slice(0, this.buffered.length - hold);
    this.buffered = this.buffered.slice(this.buffered.length - hold);

    if (this.inside) this.captured += settled;
    else display += settled;

    return { text: display, steps };
  }

  /** Whatever is still held back once the stream ends. */
  flush(): string {
    const rest = this.inside ? '' : this.buffered;
    this.buffered = '';
    return rest;
  }
}

/** Length of the trailing run of `text` that could still grow into `marker`. */
function partialMarkerLength(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (marker.startsWith(text.slice(text.length - len))) return len;
  }
  return 0;
}

/**
 * Accepts either JSON or a markdown checklist inside the block:
 *
 *   [PLAN]
 *   - [ ] Check pod status (kubernetes_read)
 *   - [ ] Query latency (prometheus_query)
 *   [/PLAN]
 */
function parsePlanBlock(block: string): PlanStep[] | undefined {
  const trimmed = block.trim();
  if (!trimmed) return undefined;

  const json = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (json.startsWith('[') || json.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(json);
      const steps = normalizeSteps(
        Array.isArray(parsed) ? parsed : (parsed as { plan?: unknown; steps?: unknown }).plan ??
          (parsed as { steps?: unknown }).steps,
      );
      if (steps) return steps;
    } catch {
      // Fall through to the checklist form.
    }
  }

  const rows = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s|^\d+[.)]\s/.test(line))
    .map((line) => {
      const text = line
        .replace(/^[-*]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^\[[ xX]\]\s*/, '')
        .trim();
      // A trailing "(tool_name)" names the tool that carries out the step.
      const tool = /\(([a-z][a-z0-9_]*)\)\s*$/i.exec(text)?.[1];
      return {
        label: tool ? text.slice(0, text.lastIndexOf('(')).trim() : text,
        ...(tool ? { tool } : {}),
      };
    })
    .filter((step) => step.label.length > 0);

  return normalizeSteps(rows);
}
