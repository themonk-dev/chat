import { parseJsonEventStream } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withSseTailFlush } from "./sse-tail";

/** Simulates a network response arriving as the given raw chunks, in order. */
function sseResponse(chunks: string[], contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, { headers: { "content-type": contentType } });
}

/** The wrapped fetch, answering with exactly these chunks. */
function wrapped(chunks: string[], contentType?: string): typeof fetch {
  return withSseTailFlush(() =>
    Promise.resolve(sseResponse(chunks, contentType))
  );
}

async function readAll(response: Response): Promise<string> {
  return await new Response(response.body).text();
}

/**
 * Every event the AI SDK dispatches from a body — the actual question this
 * wrapper exists to answer.
 *
 * `parseJsonEventStream` is the AI SDK's own entry point, the one every
 * provider's `doStream` hands its response body to; it is
 * `TextDecoderStream` → `EventSourceParserStream` → JSON parse. Driving the
 * real thing rather than a stand-in is what makes the "without the wrapper,
 * nothing arrives" assertions below evidence instead of restatement.
 */
async function parsedEvents(response: Response): Promise<unknown[]> {
  if (!response.body) {
    return [];
  }

  const reader = parseJsonEventStream({
    schema: z.unknown(),
    stream: response.body,
  }).getReader();
  const values: unknown[] = [];

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: draining a reader is inherently sequential — each read depends on the last one's result
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    values.push(value.success ? value.value : "PARSE_FAILED");
  }

  return values;
}

describe("withSseTailFlush", () => {
  /**
   * The regression itself, stated as the symptom rather than as byte
   * arithmetic: a provider answers a short reply as one event and closes the
   * socket without a trailing blank line.
   *
   * `eventsource-parser@3.1.0`'s `EventSourceParserStream` defines only
   * `start` and `transform` — no `flush` — so the event it is still holding
   * when the source ends is discarded silently. The unwrapped control below
   * pins that down: if it ever starts passing on its own, the upstream parser
   * grew a flush and this wrapper can be reconsidered.
   */
  it("recovers a final event the stream never terminated", async () => {
    const chunks = ['data: {"text":"ok"}'];

    expect(await parsedEvents(sseResponse(chunks))).toEqual([]);

    const response = await wrapped(chunks)("https://x.test");

    expect(await parsedEvents(response)).toEqual([{ text: "ok" }]);
  });

  it("recovers a final event terminated by a line break but no blank line", async () => {
    const chunks = ['data: {"a":1}\n\ndata: {"b":2}\n'];

    expect(await parsedEvents(sseResponse(chunks))).toEqual([{ a: 1 }]);

    const response = await wrapped(chunks)("https://x.test");

    expect(await parsedEvents(response)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("leaves a properly terminated stream byte-identical", async () => {
    const body = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const response = await wrapped([body])("https://x.test");

    expect(await readAll(response)).toBe(body);
  });

  it("recognises CRLF terminators without adding a redundant one", async () => {
    const body = 'data: {"a":1}\r\n\r\n';
    const response = await wrapped([body])("https://x.test");

    expect(await readAll(response)).toBe(body);
  });

  it("completes a CRLF-terminated line that lacks its blank line", async () => {
    const response = await wrapped(['data: {"a":1}\r\n'])("https://x.test");

    expect(await parsedEvents(response)).toEqual([{ a: 1 }]);
  });

  it("appends nothing to an empty stream", async () => {
    const response = await wrapped([])("https://x.test");

    expect(await readAll(response)).toBe("");
  });

  it("terminates across a chunk boundary that lands inside the last event", async () => {
    // The tail bytes have to be tracked across `transform` calls, not read off
    // the final chunk alone — the last chunk here is a bare `}` and says
    // nothing about what preceded it.
    const response = await wrapped(['data: {"text":"spl', 'it"', "}"])(
      "https://x.test"
    );

    expect(await parsedEvents(response)).toEqual([{ text: "split" }]);
  });

  it("passes a non-SSE response through untouched, body and all", async () => {
    const inner: typeof fetch = () =>
      Promise.resolve(Response.json({ data: [] }));
    const response = await withSseTailFlush(inner)("https://x.test");

    expect(await response.json()).toEqual({ data: [] });
  });

  it("preserves status, statusText and headers on the SSE path", async () => {
    const inner: typeof fetch = () =>
      Promise.resolve(
        new Response("data: {}\n\n", {
          headers: { "content-type": "text/event-stream", "x-req": "abc" },
          status: 201,
          statusText: "Created",
        })
      );
    const response = await withSseTailFlush(inner)("https://x.test");

    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("x-req")).toBe("abc");
  });

  it("forwards the url and init it was called with", async () => {
    let seen: [unknown, unknown] = [undefined, undefined];
    const inner: typeof fetch = (url, init) => {
      seen = [url, init];
      return Promise.resolve(new Response("{}"));
    };

    await withSseTailFlush(inner)("https://x.test/path", { method: "POST" });

    expect(seen[0]).toBe("https://x.test/path");
    expect(seen[1]).toEqual({ method: "POST" });
  });
});
