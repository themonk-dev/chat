/**
 * Guarantees a streamed SSE body ends with an event terminator.
 *
 * A server-sent-events stream dispatches an event when it reads a blank line.
 * A stream is not obliged to send one before it closes, and several of these
 * providers do not: a short reply arrives as a single `data:` frame and the
 * socket closes with no trailing blank line behind it.
 *
 * Nothing downstream recovers that event. The AI SDK parses every provider's
 * stream with `eventsource-parser`'s `EventSourceParserStream`, which defines
 * only `start` and `transform` — there is no `flush`, so whatever the parser
 * is still holding when the source closes is dropped without an error. The
 * symptom is an empty assistant bubble and no diagnostic anywhere: the request
 * succeeded, the bytes arrived, and the last event evaporated between the
 * socket and the renderer.
 *
 * The predecessor playground hand-rolled its SSE reader and drained the buffer
 * itself after the read loop, documenting exactly this ("a one-chunk answer
 * rendered as an empty message"). Delegating parsing to the AI SDK lost that,
 * for all seven providers at once. Rather than re-hand-rolling the parser,
 * this restores the property the parser assumes: by the time the stream ends,
 * every event it carried has been terminated.
 *
 * Applied as a `fetch` wrapper because that is the one seam every AI SDK
 * provider factory exposes, and it sits below the SDK's own parsing.
 *
 * Note the deliberate second-order effect: a stream that ends *mid-event*
 * (genuinely truncated JSON, not merely an unterminated complete one) is now
 * terminated too, so the SDK parses a broken frame and surfaces an error part
 * instead of silently rendering nothing. That is the better of the two — a
 * truncated response is a failure and should read as one.
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
 * What has to be appended so the stream ends on a blank line, given the last
 * few bytes that went past.
 *
 * An empty stream gets nothing — there is no event to terminate, and inventing
 * one would turn "the provider sent nothing" into a parse of nothing. A stream
 * already ending on a blank line (in any of SSE's three line-ending flavours)
 * gets nothing either. A stream ending mid-line needs both its line ending and
 * the blank line; one ending on a single line break needs only the blank line.
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
 * Passes every chunk through untouched, remembering only the last few bytes,
 * and appends whatever terminator the stream turned out to be missing.
 *
 * Byte-level rather than text-level on purpose: this must not decode, buffer,
 * or re-encode the body. Any of those would delay the first token or corrupt a
 * multi-byte character split across a chunk boundary, and the question being
 * asked ("did this end on a blank line?") is answerable from the raw bytes —
 * `\r` and `\n` are single-byte in UTF-8 and cannot occur inside a multi-byte
 * sequence.
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
