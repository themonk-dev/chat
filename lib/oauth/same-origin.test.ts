import { describe, expect, it } from "vitest";
import { isForeignOrigin } from "./same-origin";

const requestWith = (site?: string) =>
  new Request("https://chat.themonk.dev/api/upstream/claude/v1/messages", {
    headers: site ? { "sec-fetch-site": site } : undefined,
    method: "POST",
  });

describe("isForeignOrigin", () => {
  it("admits the app's own page", () => {
    expect(isForeignOrigin(requestWith("same-origin"))).toBe(false);
  });

  /**
   * The case this exists for: a page on someone else's domain calling this
   * proxy to reach an API its own origin cannot, spending our function time.
   */
  it.each([
    ["cross-site"],
    ["same-site"],
    ["none"],
  ])("rejects a request a browser reports as %s", (site) => {
    expect(isForeignOrigin(requestWith(site))).toBe(true);
  });

  /**
   * curl, a script, a server. Blocking these would be theatre — they can call
   * api.anthropic.com directly, which is the only thing the proxy is for.
   */
  it("admits a caller that is not a browser", () => {
    expect(isForeignOrigin(requestWith())).toBe(false);
  });
});
