import { describe, expect, it } from "vitest";
import { wrapCodeAssist } from "./gemini-envelope";

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

    expect(seen).toEqual({
      model: "gemini-2.5-pro",
      project: "proj-1",
      request: { contents: [] },
    });
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

  it("leaves a URL with no /models/{id} segment untouched", async () => {
    let seenUrl: string | undefined;
    const inner: typeof fetch = (url) => {
      seenUrl = String(url);
      return Promise.resolve(new Response("{}"));
    };

    await wrapCodeAssist(
      "p",
      "m",
      inner
    )("https://x.test", {
      body: "{}",
      method: "POST",
    });

    expect(seenUrl).toBe("https://x.test");
  });
});
