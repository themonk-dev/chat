/**
 * SSE dispatches an event on a blank line, and several providers close without
 * sending one. The AI SDK's parser has no `flush`, so whatever it is still
 * holding is dropped silently — an empty assistant bubble and no diagnostic.
 * This restores the property that parser assumes.
 *
 * A genuinely truncated stream now surfaces a parse error rather than nothing,
 * which is the better of the two.
 */

/** `\n` */
const LF = 0x0a;
/** `\r` */
const CR = 0x0d;

/** Longest terminator this has to recognise (`\r\n\r\n`). */
const TAIL_BYTES = 4;

export function withSseTailFlush(inner: typeof fetch = fetch): typeof fetch {
  return async (url, init) => {
    const response = await inner(url, init);
    const type = response.headers.get("content-type") ?? "";

    if (!(type.includes("text/event-stream") && response.body)) {
      return response;
    }

    return new Response(terminateFinalEvent(response.body), {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

/** Whether `tail`'s last bytes are exactly `suffix`. */
function endsWith(tail: number[], suffix: number[]): boolean {
  const offset = tail.length - suffix.length;

  return (
    offset >= 0 && suffix.every((byte, index) => tail[offset + index] === byte)
  );
}

/**
 * Nothing for an empty stream or one already ending on a blank line; otherwise
 * whichever of the line ending and the blank line is missing.
 */
function missingTerminator(tail: number[]): string {
  if (tail.length === 0) {
    return "";
  }

  if (
    endsWith(tail, [LF, LF]) ||
    endsWith(tail, [CR, CR]) ||
    endsWith(tail, [CR, LF, CR, LF])
  ) {
    return "";
  }

  return endsWith(tail, [LF]) || endsWith(tail, [CR]) ? "\n" : "\n\n";
}

/**
 * Byte-level rather than text-level: decoding would delay the first token or
 * corrupt a character split across a chunk boundary, and `\r`/`\n` cannot occur
 * inside a multi-byte UTF-8 sequence anyway.
 */
function terminateFinalEvent(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  let tail: number[] = [];

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        const terminator = missingTerminator(tail);

        if (terminator) {
          controller.enqueue(new TextEncoder().encode(terminator));
        }
      },
      transform(chunk, controller) {
        if (chunk.length > 0) {
          tail = [...tail, ...chunk.slice(-TAIL_BYTES)].slice(-TAIL_BYTES);
        }

        controller.enqueue(chunk);
      },
    })
  );
}
