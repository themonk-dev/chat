import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_ID,
  flowFor,
  isLoopbackOrigin,
  PROVIDER_ORDER,
  registry,
} from "./registry";

/**
 * Claude and Gemini are the two entries in the registry that are not
 * constants, and these are the cases that decide them. They are written against
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
   * Claude is origin-dependent for the same reason Gemini is, and this is the
   * regression that says so. It shipped as popup-on-every-origin, which a
   * deployed origin answers with
   *
   *   Redirect URI https://<host>/callback is not supported by client
   *
   * because Anthropic's published client registers only loopback and its own
   * hosted page (`redirect.hostedUri` on the SDK descriptor). The paste flow
   * sends that hosted page as the redirect URI, so it is the one that works
   * off loopback.
   */
  it("gives Claude the popup flow only on loopback", () => {
    expect(flowFor("claude", { hostname: "localhost" })).toBe("popup");
    expect(flowFor("claude", { hostname: "127.0.0.1" })).toBe("popup");
    expect(flowFor("claude", { hostname: "[::1]" })).toBe("popup");
  });

  it("falls Claude back to paste anywhere a redirect URI is not registered", () => {
    expect(flowFor("claude", { hostname: "chat.themonk.dev" })).toBe("paste");
    expect(
      flowFor("claude", { hostname: "chat-git-branch-themonkdev.vercel.app" })
    ).toBe("paste");
    expect(flowFor("claude", { hostname: "app.localhost" })).toBe("paste");
    expect(flowFor("claude", undefined)).toBe("paste");
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
      if (id === "claude" || id === "gemini") {
        continue;
      }

      expect(flowFor(id, { hostname: "localhost" })).toBe(entry.flow);
      expect(flowFor(id, { hostname: "chat.themonk.dev" })).toBe(entry.flow);
    }
  });
});

/**
 * The connect card names `registry[activeId].label`, and `activeId` starts at
 * `DEFAULT_PROVIDER_ID`. Reordering the list used to leave that behind as a
 * separate literal, so the card went on offering OpenRouter while the picker
 * and the provider list had already moved on.
 */
describe("the provider a first visit lands on", () => {
  it("is whichever one leads the list", () => {
    expect(DEFAULT_PROVIDER_ID).toBe(PROVIDER_ORDER[0]);
  });

  it("is a provider the registry can name and the dialog can sign in", () => {
    expect(registry[DEFAULT_PROVIDER_ID]).toBeDefined();
    expect(registry[DEFAULT_PROVIDER_ID].label).toBe("ChatGPT");
  });

  it("leaves nothing in PROVIDER_ORDER that the registry does not know", () => {
    for (const id of PROVIDER_ORDER) {
      expect(registry[id]).toBeDefined();
    }
  });
});
