/**
 * Code Assist wraps the standard `generateContent` body as
 * `{model, project, request}` and every reply as `{response}`, so adding and
 * removing the envelope in `fetch` lets the stock adapter drive it unmodified.
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
      // `user_prompt_id` is what gemini-cli sends per turn; matching the
      // client this token's scope belongs to is the safer side of an unknown.
      body: JSON.stringify({
        model,
        project,
        request,
        user_prompt_id: crypto.randomUUID(),
      }),
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
 * Code Assist routes are `POST {base}:generateContent`, so the `/models/{id}`
 * segment `@ai-sdk/google` hardcodes 404s. Matched on the path only, so a query
 * string of the same shape cannot be over-stripped.
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
 * Per line rather than per body, so the stream keeps flowing — and buffered
 * across chunks, because a `data:` line split over two chunks would fail
 * `JSON.parse` on both halves and leak the envelope downstream as silent token
 * loss. `flush()`'s argument-less `decode()` releases a trailing multi-byte
 * character.
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
          // The trailing "\n" matters: a tail flushed without one hands the
          // SSE parser an unterminated line, which it holds and then drops.
          controller.enqueue(encoder.encode(`${rewriteLine(buffer)}\n`));
        }
      },
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        const lines = buffer.split("\n");

        // Whatever follows the final "\n" is not yet a complete line.
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
