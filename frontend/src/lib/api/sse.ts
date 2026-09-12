/**
 * Reading a `text/event-stream` response. ONE parser, every surface.
 *
 * This logic was written out three times in `public.ts` — briefing, agent chat and
 * explore — and Direct Chat would have been the fourth. Each copy has to get the
 * same four things right, and a copy that gets one of them wrong fails in a way that
 * looks like a backend bug:
 *
 *   partial frames   a chunk can end mid-JSON, so the tail is kept for the next read
 *   comment frames   the server sends `: keepalive` every 8s to stop proxies (and
 *                    the browser) calling a slow model a dead connection. A block
 *                    with no `data:` line is skipped rather than parsed.
 *   termination      `done` ends the stream, and so does the reader running out
 *   silence          a stream that stops arriving must fail loudly, not hang
 *
 * What it deliberately does NOT do is build the request. URL, headers and body are
 * the caller's — that is where a public link's token and BYOK headers live, and
 * where an authenticated route has none of them.
 */

export class AiStreamIdleError extends Error {
  constructor(message = 'AI stream idle') {
    super(message);
    this.name = 'AiStreamIdleError';
  }
}

/** Read one chunk, or give up if nothing arrives for `idleMs`.
 *
 *  A dead socket and a thinking model look identical from here; the server's
 *  keepalive comment is what tells them apart, so any arriving byte — comment
 *  included — resets this timer. */
async function readWithIdle<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new AiStreamIdleError()), idleMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Yield one parsed JSON payload per SSE frame, until `done` or end of stream.
 *
 * `T` is the caller's event union — this function does not validate it, because the
 * wire format is the server's contract and a parser that silently dropped an event
 * it did not recognise would hide exactly the bug worth seeing.
 */
export async function* parseSseStream<T = unknown>(
  response: Response,
  opts: { idleMs?: number; isTerminal?: (ev: T) => boolean } = {},
): AsyncGenerator<T, void, unknown> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const idleMs = opts.idleMs ?? 0;
  const isTerminal =
    opts.isTerminal ?? ((ev: T) => (ev as { type?: string })?.type === 'done');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = idleMs > 0
      ? await readWithIdle(reader, idleMs)
      : await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    // The last element is whatever came after the final blank line — an
    // incomplete frame — so it goes back in the buffer rather than to JSON.parse.
    buffer = blocks.pop() ?? '';

    for (const block of blocks) {
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue; // `: keepalive`, and anything else without a payload
      let parsed: T;
      try {
        parsed = JSON.parse(line.slice(5).trim()) as T;
      } catch {
        continue;
      }
      yield parsed;
      if (isTerminal(parsed)) return;
    }
  }
}
