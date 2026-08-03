/**
 * Makes Google's Code Assist surface look like the ordinary Generative Language
 * API, so the stock `@ai-sdk/google` adapter can drive it unmodified.
 *
 * Code Assist is the surface a Gemini OAuth token is scoped to, and it is not
 * the documented API — it wraps the standard `generateContent` body as
 * `{model, project, request}` and wraps every reply as `{response}`. Since the
 * inner payload is byte-for-byte the standard one, a `fetch` that adds the
 * envelope on the way out and removes it on the way back is most of the
 * difference.
 *
 * The other part is the URL. `@ai-sdk/google` always builds
 * `${baseURL}/${models/{id}}:{method}` — there is no way to configure it
 * otherwise — but Code Assist's real route is `${base}:{method}` with no
 * `/models/{id}` segment at all; the model travels in the envelope instead.
 * `stripModelSegment` removes exactly that segment so the request lands on a
 * route Code Assist actually serves.
 */
export function wrapCodeAssist(
  project: string,
  model: string,
  inner: typeof fetch = fetch
): typeof fetch {
  return async (url, init) => {
    const request: unknown = init?.body ? JSON.parse(String(init.body)) : {};

    const response = await inner(stripModelSegment(url), {
      ...init,
      body: JSON.stringify({ model, project, request }),
    });

    const type = response.headers.get("content-type") ?? "";

    if (type.includes("text/event-stream") && response.body) {
      return new Response(unwrapStream(response.body), {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (!response.ok) {
      return response;
    }

    const payload = (await response.json()) as { response?: unknown };

    return new Response(JSON.stringify(payload.response ?? payload), {
      headers: { "content-type": "application/json" },
      status: response.status,
    });
  };
}

/**
 * Drops the `/models/{id}` segment `@ai-sdk/google` hardcodes into the request
 * URL.
 *
 * Code Assist's method routes are `POST {base}:generateContent`, not the
 * public API's `POST {base}/models/{id}:generateContent` — the model is only
 * ever read out of the envelope body. Left in place, the extra segment is a
 * route Code Assist has never registered, and the request 404s before the
 * envelope wrapping above gets a chance to matter.
 *
 * A `Request` object is returned unchanged: the SDK only ever calls this with
 * a string URL, and rewriting a `Request`'s URL means constructing a new one
 * anyway, which is no simpler than leaving the (rare, likely test-only) case
 * alone.
 *
 * The regex is applied to the path only, split off before the `?`. Applied
 * to the whole URL it can also match inside a query string that happens to
 * contain the same `/models/{id}:` shape — a real caller would never send
 * one, but nothing about matching the full string rules it out either, and
 * "cannot over-strip" is exactly the guarantee this function needs to hold.
 */
function stripModelSegment(
  url: string | URL | Request
): string | URL | Request {
  if (typeof url !== "string") {
    return url;
  }

  const [path, query] = url.split("?");
  const strippedPath = path.replace(/\/models\/[^/:?#]+:/, ":");

  return query === undefined ? strippedPath : `${strippedPath}?${query}`;
}

/** Rewrites one already-complete SSE line; anything else passes through untouched. */
function rewriteLine(line: string): string {
  if (!line.startsWith("data:")) {
    return line;
  }

  const data = line.slice(5).trim();

  if (!data || data === "[DONE]") {
    return line;
  }

  try {
    const parsed = JSON.parse(data) as { response?: unknown };

    return `data: ${JSON.stringify(parsed.response ?? parsed)}`;
  } catch {
    return line;
  }
}

/**
 * Rewrites each `data:` line rather than the whole body, because the stream has
 * to keep flowing — buffering it to unwrap once would hold the reply until the
 * last token before the reader saw the first.
 *
 * That still requires a line buffer *within* the transform, though. A network
 * chunk boundary has no relationship to a line boundary — a multi-KB Gemini
 * event routinely straddles one — and a `data:` line split across two chunks
 * fails `JSON.parse` on both halves independently: the first half is
 * incomplete JSON, the second doesn't start with `data:` at all, so both pass
 * through unrewritten and the envelope survives into what `@ai-sdk/google`
 * parses. That is not an error on either end, just an object with no
 * `candidates` — silent token loss, not a thrown one. Carrying the trailing
 * (possibly partial) line across `transform` calls, and processing whatever
 * is left in `flush()`, is what makes each rewrite decision operate on a
 * complete line regardless of how the bytes were chunked.
 *
 * `flush()`'s own `decoder.decode()` call (no arguments) also matters on its
 * own: that is what flushes a multi-byte UTF-8 character split across the
 * very last two chunks of the stream, which `{ stream: true }` deliberately
 * holds back mid-stream and would otherwise drop.
 */
function unwrapStream(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        buffer += decoder.decode();

        if (buffer) {
          controller.enqueue(encoder.encode(rewriteLine(buffer)));
        }
      },
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        const lines = buffer.split("\n");
        // The last element is whatever follows the final "\n" in the
        // buffer — empty when the chunk ended exactly on a line break,
        // otherwise a partial line completed by whatever arrives next.
        // Either way it is not yet a complete line, so it is held back
        // rather than rewritten.
        buffer = lines.pop() ?? "";

        if (lines.length > 0) {
          controller.enqueue(
            encoder.encode(`${lines.map(rewriteLine).join("\n")}\n`)
          );
        }
      },
    })
  );
}
