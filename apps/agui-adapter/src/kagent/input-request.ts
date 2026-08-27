import type { PendingInput, PendingInputOption } from '@scp/contracts';
import { checkPendingInput } from '@scp/contracts';
import type { A2AMessage, A2APart, A2ATextPart } from './a2a.js';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function normalizeOptions(raw: unknown): PendingInputOption[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const options: PendingInputOption[] = [];
  for (const entry of raw) {
    const source = typeof entry === 'string' ? { value: entry, label: entry } : entry;
    if (!source || typeof source !== 'object') continue;
    const o = source as Record<string, unknown>;
    const value = str(o.value) ?? str(o.id) ?? str(o.label);
    const label = str(o.label) ?? str(o.title) ?? value;
    if (!value || !label) continue;
    options.push({
      value,
      label,
      ...(str(o.detail) ? { detail: str(o.detail)! } : {}),
      ...(str(o.risk) ? { risk: str(o.risk) as PendingInputOption['risk'] } : {}),
    });
  }
  return options.length > 0 ? options : undefined;
}

/** A structured input or approval request carried in a DataPart. */
export function inputRequestFromPart(part: A2APart): PendingInput | undefined {
  if (part.kind !== 'data') return undefined;
  const data = (part as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;

  const marker = (str(d.kind) ?? str(d.type) ?? '').toLowerCase().replace(/[-\s]/g, '_');
  if (
    marker !== 'input_request' &&
    marker !== 'input_required' &&
    marker !== 'approval_request' &&
    marker !== 'ask_user'
  ) {
    return undefined;
  }

  const prompt = str(d.prompt) ?? str(d.question) ?? str(d.message) ?? str(d.text);
  if (!prompt) return undefined;

  const options = normalizeOptions(d.options ?? d.choices);
  const candidate: PendingInput = {
    prompt,
    ...(options ? { options } : {}),
    ...(typeof d.allow_free_text === 'boolean' ? { allow_free_text: d.allow_free_text } : {}),
    ...(d.capability && typeof d.capability === 'object'
      ? { capability: d.capability as Record<string, unknown> }
      : {}),
  };

  return checkPendingInput(candidate).ok ? candidate : undefined;
}

/**
 * Falls back to the text of the message the agent paused on.
 *
 * An agent that simply stops in `input-required` after asking a question in
 * prose still gets a working prompt, just without offered choices.
 */
export function inputRequestFromMessage(message: A2AMessage | undefined): PendingInput | undefined {
  if (!message) return undefined;

  for (const part of message.parts ?? []) {
    const structured = inputRequestFromPart(part);
    if (structured) return structured;
  }

  const text = (message.parts ?? [])
    .filter((p): p is A2ATextPart => p.kind === 'text')
    .map((p) => p.text)
    .join('')
    .trim();

  return text ? { prompt: text } : undefined;
}
