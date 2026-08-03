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
 */
function stripModelSegment(
  url: string | URL | Request
): string | URL | Request {
  if (typeof url !== "string") {
    return url;
  }

  return url.replace(/\/models\/[^/:?#]+:/, ":");
}

/**
 * Rewrites each `data:` line rather than the whole body, because the stream has
 * to keep flowing — buffering it to unwrap once would hold the reply until the
 * last token before the reader saw the first.
 */
function unwrapStream(
  body: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });

        const rewritten = text
          .split("\n")
          .map((line) => {
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
          })
          .join("\n");

        controller.enqueue(encoder.encode(rewritten));
      },
    })
  );
}
