import { describe, expect, it } from "vitest";
import { flowFor, isLoopbackOrigin, registry } from "./registry";

/**
 * Gemini's flow is the one entry in the registry that is not a constant, and
 * these are the cases that decide it. They are written against
 * `flowFor`/`isLoopbackOrigin` directly, with the origin passed in, because
 * jsdom's `window.location` is unforgeable — a test that wanted to move the
 * origin could not — and because the branch is a fact about an origin, not
 * about a browser.
 *
 * Every hostname below was probed against Google's real authorization
 * endpoint with the published gemini-cli client id; see `isLoopbackOrigin`
 * for what each one answered.
 */
describe("flowFor", () => {
  it("gives Gemini the popup flow on every loopback origin Google accepts", () => {
    expect(flowFor("gemini", { hostname: "localhost" })).toBe("popup");
    expect(flowFor("gemini", { hostname: "127.0.0.1" })).toBe("popup");
    expect(flowFor("gemini", { hostname: "[::1]" })).toBe("popup");
  });

  /**
   * Claude is not origin-dependent, and this is the case that says so.
   *
   * Anthropic accepts `https://<our origin>/callback` for the published
   * Claude Code client — probed live, signed in, where
   * `https://chat.themonk.dev/callback` reached the consent screen rather
   * than a `redirect_uri_mismatch`. So there is no loopback exception to
   * make and no paste to fall back to: the same popup runs everywhere,
   * including the deployed site.
   */
  it("gives Claude the popup flow on every origin", () => {
    expect(flowFor("claude", { hostname: "localhost" })).toBe("popup");
    expect(flowFor("claude", { hostname: "chat.themonk.dev" })).toBe("popup");
    expect(flowFor("claude", { hostname: "app.localhost" })).toBe("popup");
    expect(flowFor("claude", undefined)).toBe("popup");
  });

  it("leaves Gemini on the paste flow anywhere else", () => {
    expect(flowFor("gemini", { hostname: "chat.themonk.dev" })).toBe("paste");
    expect(flowFor("gemini", { hostname: "ai-oauth.themonk.dev" })).toBe(
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
  });

  it("leaves every other provider's declared flow alone", () => {
    for (const [id, entry] of Object.entries(registry)) {
      if (id === "gemini") {
        continue;
      }

      expect(flowFor(id, { hostname: "localhost" })).toBe(entry.flow);
      expect(flowFor(id, { hostname: "chat.themonk.dev" })).toBe(entry.flow);
    }
  });
});
