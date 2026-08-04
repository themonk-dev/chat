import { describe, expect, it } from "vitest";
import { flowFor, isLoopbackOrigin, registry } from "./registry";

/**
 * Claude's and Gemini's flows are the two entries in the registry that are
 * not constants, and these are the cases that decide them. They are written
 * against `flowFor`/`isLoopbackOrigin` directly, with the origin passed in,
 * because jsdom's `window.location` is unforgeable — a test that wanted to
 * move the origin could not — and because the branch is a fact about an
 * origin, not about a browser.
 *
 * Every hostname below was probed against Google's real authorization
 * endpoint with the published gemini-cli client id; see `isLoopbackOrigin`
 * for what each one answered, and for why Anthropic's is held to the same
 * list without a probe of its own.
 */
describe("flowFor", () => {
  it("gives Gemini the popup flow on every loopback origin Google accepts", () => {
    expect(flowFor("gemini", { hostname: "localhost" })).toBe("popup");
    expect(flowFor("gemini", { hostname: "127.0.0.1" })).toBe("popup");
    expect(flowFor("gemini", { hostname: "[::1]" })).toBe("popup");
  });

  /**
   * Claude declares the same loopback redirect Gemini does, so on loopback it
   * gets the same treatment: the popup lands back on our own `/callback` and
   * hands the code over itself. Without this, the reader copies a
   * `CODE#STATE` string off Anthropic's hosted page by hand.
   */
  it("gives Claude the popup flow on loopback too", () => {
    expect(flowFor("claude", { hostname: "localhost" })).toBe("popup");
    expect(flowFor("claude", { hostname: "127.0.0.1" })).toBe("popup");
    expect(flowFor("claude", { hostname: "[::1]" })).toBe("popup");
  });

  it("leaves Gemini on the paste flow anywhere else", () => {
    expect(flowFor("gemini", { hostname: "chat.themonk.dev" })).toBe("paste");
    expect(flowFor("gemini", { hostname: "ai-oauth.themonk.dev" })).toBe(
      "paste"
    );
  });

  /**
   * The deployed site is the case this protects. Anthropic accepts two kinds
   * of redirect for this client — loopback, and its own hosted callback page
   * — and the hosted page is cross-origin, so a popup opened onto it can
   * never be read. On `chat.themonk.dev` the paste flow is not a fallback;
   * it is the only thing that works.
   */
  it("leaves Claude on the paste flow anywhere else", () => {
    expect(flowFor("claude", { hostname: "chat.themonk.dev" })).toBe("paste");
    expect(flowFor("claude", { hostname: "ai-oauth.themonk.dev" })).toBe(
      "paste"
    );
  });

  /**
   * `app.localhost` resolves to the loopback interface but is not a loopback
   * redirect as far as Google is concerned: the probe came back
   * `invalid_request` with the "doesn't comply with Google's OAuth 2.0
   * policy" text, not a consent screen. A hostname test that merely ended
   * with `localhost` would have shipped a sign-in that always fails.
   */
  it("does not treat a subdomain of localhost as loopback", () => {
    expect(flowFor("gemini", { hostname: "app.localhost" })).toBe("paste");
    expect(flowFor("gemini", { hostname: "notlocalhost" })).toBe("paste");
    expect(flowFor("claude", { hostname: "app.localhost" })).toBe("paste");
  });

  /**
   * Rendered on the server there is no origin to read, and the flow that
   * works everywhere is the one to assume. The dialog never renders its
   * flow-dependent body until it is opened by a click, so this answer never
   * reaches the DOM the client hydrates against.
   */
  it("assumes no loopback when there is no origin to read", () => {
    expect(isLoopbackOrigin(undefined)).toBe(false);
    expect(flowFor("gemini", undefined)).toBe("paste");
    expect(flowFor("claude", undefined)).toBe("paste");
  });

  it("leaves every other provider's declared flow alone", () => {
    for (const [id, entry] of Object.entries(registry)) {
      if (id === "gemini" || id === "claude") {
        continue;
      }

      expect(flowFor(id, { hostname: "localhost" })).toBe(entry.flow);
      expect(flowFor(id, { hostname: "chat.themonk.dev" })).toBe(entry.flow);
    }
  });
});
