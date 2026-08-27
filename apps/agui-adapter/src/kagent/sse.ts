const FRAME_SEPARATOR = /\r?\n\r?\n/;

/**
 * Minimal SSE reader over a fetch Response body.
 *
 * Only what the A2A wire format needs: `data:` lines accumulated until a blank
 * line, other fields ignored. Frames split across chunks are reassembled.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const separator = FRAME_SEPARATOR.exec(buffer);
        if (!separator) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = extractData(frame);
        if (data) yield data;
      }
    }

    // A well-behaved server ends with a blank line, but do not lose a final
    // frame if it does not.
    const tail = extractData(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function extractData(frame: string): string {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''))
    .join('\n');
}
