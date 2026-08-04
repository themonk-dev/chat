import { parseJsonEventStream } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { wrapCodeAssist } from "./gemini-envelope";
import { withSseTailFlush } from "./sse-tail";

/** Simulates a network response arriving as the given raw chunks, in order. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function readAll(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let out = "";

  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: draining a reader is inherently sequential — each read depends on the last one's result
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    out += decoder.decode(value, { stream: true });
  }

  out += decoder.decode();

  return out;
}

describe("wrapCodeAssist", () => {
  it("wraps the outbound body in the Code Assist envelope", async () => {
    let seen: unknown;
    const inner: typeof fetch = (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return Promise.resolve(new Response("{}"));
    };

    await wrapCodeAssist(
      "proj-1",
      "gemini-2.5-pro",
      inner
    )("https://x.test", {
      body: JSON.stringify({ contents: [] }),
      method: "POST",
    });

    expect(seen).toMatchObject({
      model: "gemini-2.5-pro",
      project: "proj-1",
      request: { contents: [] },
    });
  });

  it("sends a per-turn user_prompt_id, as gemini-cli and the predecessor did", async () => {
    // Dropped in the port. Restored because the token in play is scoped to
    // gemini-cli's client, and looking like that client on a surface Google
    // does not document is the safer side of an unknown.
    const seen: string[] = [];
    const inner: typeof fetch = (_url, init) => {
      seen.push(JSON.parse(String(init?.body)).user_prompt_id);
      return Promise.resolve(new Response("{}"));
    };
    const send = () =>
      wrapCodeAssist(
        "p",
        "m",
        inner
      )("https://x.test", { body: "{}", method: "POST" });

    await send();
    await send();

    expect(seen[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("unwraps the response envelope", async () => {
    const inner: typeof fetch = () =>
      Promise.resolve(Response.json({ response: { candidates: [] } }));

    const response = await wrapCodeAssist(
      "p",
      "m",
      inner
    )("https://x.test", {
      body: "{}",
      method: "POST",
    });

    expect(await response.json()).toEqual({ candidates: [] });
  });

  it("strips a spurious /models/{id} segment the AI SDK appends", async () => {
    let seenUrl: string | undefined;
    const inner: typeof fetch = (url) => {
      seenUrl = String(url);
      return Promise.resolve(new Response("{}"));
    };

    await wrapCodeAssist(
      "proj-1",
      "gemini-2.5-pro",
      inner
    )(
      "/api/upstream/gemini/v1internal/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      { body: "{}", method: "POST" }
    );

    expect(seenUrl).toBe(
      "/api/upstream/gemini/v1internal:streamGenerateContent?alt=sse"
    );
  });

  it("leaves a /models/{id} segment untouched when nothing follows it with a colon", async () => {
    // A naive "strip any /models/xxx" regex would also eat this one. The
    // real hazard is a segment that looks like the AI SDK's own
    // `/models/{id}:method` shape but is not — e.g. a literal path
    // component, or a query string that happens to contain the substring —
    // and must survive because there is no trailing `:operation` to prove
    // it is the thing being guarded against.
    let seenUrl: string | undefined;
    const inner: typeof fetch = (requestUrl) => {
      seenUrl = String(requestUrl);
      return Promise.resolve(new Response("{}"));
    };

    const url =
      "https://x.test/v1beta/models/gemini-2.5-pro/list?from=/models/other:thing";

    await wrapCodeAssist("p", "m", inner)(url, { body: "{}", method: "POST" });

    expect(seenUrl).toBe(url);
  });

  describe("the SSE branch", () => {
    it("reassembles an event whose data: line is split across two network chunks", async () => {
      const inner: typeof fetch = () =>
        Promise.resolve(
          sseResponse([
            'data: {"respon',
            'se":{"candidates":[{"text":"hi"}]}}\n\n',
          ])
        );

      const response = await wrapCodeAssist(
        "p",
        "m",
        inner
      )("https://x.test", { body: "{}", method: "POST" });

      expect(await readAll(response)).toBe(
        'data: {"candidates":[{"text":"hi"}]}\n\n'
      );
    });

    it("unwraps every event in a single chunk carrying more than one", async () => {
      // A regression guard, not a catch: everything here arrives in one
      // `transform()` call, so there is no boundary for the buffering fix
      // to matter to — `split`+`map`+`join` on one chunk's complete text was
      // always a lossless round trip. This exists to make sure the new
      // buffering logic doesn't regress the case that was never broken.
      const inner: typeof fetch = () =>
        Promise.resolve(
          sseResponse([
            'data: {"response":{"candidates":[{"text":"one"}]}}\n\ndata: {"response":{"candidates":[{"text":"two"}]}}\n\n',
          ])
        );

      const response = await wrapCodeAssist(
        "p",
        "m",
        inner
      )("https://x.test", { body: "{}", method: "POST" });

      expect(await readAll(response)).toBe(
        'data: {"candidates":[{"text":"one"}]}\n\ndata: {"candidates":[{"text":"two"}]}\n\n'
      );
    });

    it("flushes a trailing event that never receives a closing newline", async () => {
      // The stream just ends mid-event — no more chunks, no trailing "\n" —
      // which is what a `flush()`-less transform drops on the floor.
      //
      // The "\n" the flush re-appends is load-bearing and was missing: every
      // line `transform` emits carries its terminator, and a tail emitted
      // without one is a line the SSE parser holds and then discards when the
      // source closes. Gemini lost the same event twice, here and downstream.
      const inner: typeof fetch = () =>
        Promise.resolve(
          sseResponse([
            'data: {"respon',
            'se":{"candidates":[{"text":"tail"}]}}',
          ])
        );

      const response = await wrapCodeAssist(
        "p",
        "m",
        inner
      )("https://x.test", { body: "{}", method: "POST" });

      expect(await readAll(response)).toBe(
        'data: {"candidates":[{"text":"tail"}]}\n'
      );
    });

    it("reaches the SSE parser as a real event once the tail flush is layered on", async () => {
      // Both halves of Finding 5 in one assertion, in the order adapters.ts
      // composes them: unwrap the envelope (terminating the tail line), then
      // add the blank line the parser needs to dispatch it. Either fix alone
      // still renders an empty bubble.
      const inner: typeof fetch = () =>
        Promise.resolve(
          sseResponse(['data: {"response":{"candidates":[{"text":"tail"}]}}'])
        );

      const response = await withSseTailFlush(wrapCodeAssist("p", "m", inner))(
        "https://x.test",
        { body: "{}", method: "POST" }
      );

      // `parseJsonEventStream` is the AI SDK's own SSE entry point — the one
      // every provider's `doStream` hands its body to — so this asks the real
      // consumer whether the event survived, not a stand-in.
      const reader = parseJsonEventStream({
        schema: z.unknown(),
        stream: response.body as ReadableStream<Uint8Array>,
      }).getReader();
      const events: unknown[] = [];

      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: draining a reader is inherently sequential — each read depends on the last one's result
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        events.push(value.success ? value.value : "PARSE_FAILED");
      }

      expect(events).toEqual([{ candidates: [{ text: "tail" }] }]);
    });

    it("passes a [DONE] sentinel through untouched, even split across chunks", async () => {
      // Also a regression guard rather than a catch, despite the split: a
      // [DONE] line is never rewritten in either the old or new
      // implementation, so simple concatenation of the two unrewritten
      // fragments reconstructs it correctly by coincidence either way. This
      // cannot, by construction, tell the buffering fix apart from its
      // absence — it exists to pin down that [DONE] keeps surviving once
      // real rewriting is in the mix, not to prove the chunk-boundary bug.
      const inner: typeof fetch = () =>
        Promise.resolve(
          sseResponse([
            'data: {"response":{"candidates":[{"text":"last"}]}}\n\ndata: [DON',
            "E]\n\n",
          ])
        );

      const response = await wrapCodeAssist(
        "p",
        "m",
        inner
      )("https://x.test", { body: "{}", method: "POST" });

      expect(await readAll(response)).toBe(
        'data: {"candidates":[{"text":"last"}]}\n\ndata: [DONE]\n\n'
      );
    });
  });
});
