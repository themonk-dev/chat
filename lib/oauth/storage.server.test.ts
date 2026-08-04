// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The rest of the suite runs under jsdom, where `window` and `sessionStorage`
 * exist and every one of these modules behaves. This file runs under plain
 * Node — the environment the deployed server actually is — because that is the
 * only place the bug can be observed.
 *
 * These modules all live in `"use client"` import graphs, and Next evaluates
 * those on the server during SSR. Nothing here may be reachable from a render
 * body, a Server Component, a Server Action or a route handler, because on the
 * server there is no per-user boundary to scope a store to: one module instance
 * serves every concurrent reader in the lambda.
 */

/*
 * One spy object across every re-evaluation of the module graph, so
 * `vi.resetModules()` below can re-import `./storage` from scratch and this
 * still observes whether *that* evaluation built a store.
 */
const adapterSpy = vi.hoisted(() => vi.fn());

vi.mock("@ai-oauth-sdk/browser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-oauth-sdk/browser")>();

  adapterSpy.mockImplementation(actual.sessionStorageAdapter);

  return { ...actual, sessionStorageAdapter: adapterSpy };
});

afterEach(() => {
  adapterSpy.mockClear();
});

/**
 * The reason a guard is needed at all, pinned rather than described.
 *
 * `sessionStorageAdapter()` does not throw when `sessionStorage` is missing —
 * it falls back to `memoryStorage()`, a plain `Map` closed over by the adapter.
 * That is deliberate SDK behaviour and nothing warns about it, so a token store
 * built this way on the server would work, silently, shared by everyone.
 *
 * If this test ever fails because the SDK started throwing, the guards below
 * became belt-and-braces rather than the only thing standing there. They should
 * still stay: the guard is what makes it a property of this repo.
 */
describe("the SDK fallback this guards against", () => {
  it("hands back a working process-wide store when sessionStorage is absent", async () => {
    const { sessionStorageAdapter } = await import("@ai-oauth-sdk/browser");

    expect(typeof sessionStorage).toBe("undefined");

    const first = sessionStorageAdapter();
    const second = sessionStorageAdapter();

    await first.set("provider:claude", "a-token");

    expect(await first.get("provider:claude")).toBe("a-token");
    // Separate instances, but each one is a Map that outlives any request.
    expect(await second.get("provider:claude")).toBeNull();
  });
});

describe("clientFor on the server", () => {
  it("throws rather than handing back a client backed by a shared Map", async () => {
    const { clientFor } = await import("./storage");

    expect(() => clientFor("claude")).toThrow(/browser/i);
  });

  it("constructs no storage at all — not at import, not on the way to throwing", async () => {
    vi.resetModules();
    adapterSpy.mockClear();

    const { clientFor } = await import("./storage");

    // Evaluating the module on the server must not build the fallback `Map`.
    expect(adapterSpy).not.toHaveBeenCalled();

    expect(() => clientFor("claude")).toThrow();
    expect(() => clientFor("claude")).toThrow();

    expect(adapterSpy).not.toHaveBeenCalled();
  });

  it("throws before it looks at whether the provider is even known", async () => {
    const { clientFor } = await import("./storage");

    expect(() => clientFor("not-a-provider")).toThrow(/browser/i);
  });
});

/**
 * Keying these two by the raw access token is a real read guard — a second
 * reader cannot retrieve the first's entry without already holding their token.
 * It is not a reason to let them run on the server: there they would be an
 * unbounded, process-wide, in-memory store of exchanged GitHub Copilot
 * credentials and Google Cloud project ids, held for the life of the lambda,
 * which is the opposite of what this app tells its readers.
 */
describe("the token-keyed caches on the server", () => {
  it("refuses to exchange a Copilot credential", async () => {
    const { copilotCredentialFor } = await import("./copilot");

    await expect(copilotCredentialFor("ghu_example")).rejects.toThrow(
      /browser/i
    );
  });

  it("refuses to resolve a Gemini project, before any request goes out", async () => {
    const { resolveGeminiProject } = await import("./gemini-project");
    const fetchMock = vi.fn();

    await expect(
      resolveGeminiProject("ya29.example", undefined, fetchMock)
    ).rejects.toThrow(/browser/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
