// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

/**
 * `highlightCode` is called from a render body — `CodeBlockContent` runs it in
 * a `useState` initialiser — and it writes three module-scope maps, one of
 * which (`tokensCache`) is keyed by a slice of the code itself and holds the
 * text. Module scope on the server is shared by every reader in the lambda, so
 * the only thing keeping that from being a process-wide store of readers' chat
 * content is that SSR currently renders zero messages. That is a property of
 * today's page, not of this component.
 *
 * Unlike the token stores, this one must not throw: a server-rendered code
 * block has to keep rendering. It degrades instead — raw tokens, which is what
 * the first client paint shows anyway, with the real highlight arriving from
 * the effect once there is a browser.
 */

vi.mock("shiki", () => ({ createHighlighter: vi.fn() }));

describe("highlightCode on the server", () => {
  it("caches nothing and starts no highlighter", async () => {
    const { createHighlighter } = await import("shiki");
    const { highlightCode } = await import("./code-block");

    expect(highlightCode("const a = 1;\n", "typescript")).toBeNull();
    expect(highlightCode("const a = 1;\n", "typescript")).toBeNull();

    expect(createHighlighter).not.toHaveBeenCalled();
  });

  it("does not retain a callback the server can never call back", async () => {
    const { highlightCode } = await import("./code-block");
    const callback = vi.fn();

    highlightCode("secret from another reader\n", "typescript", callback);

    expect(callback).not.toHaveBeenCalled();
  });
});
