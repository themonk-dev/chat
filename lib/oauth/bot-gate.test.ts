import { beforeEach, describe, expect, it, vi } from "vitest";

const checkBotIdMock = vi.fn();

vi.mock("botid/server", () => ({
  checkBotId: () => checkBotIdMock(),
}));

const { isBotRequest } = await import("./bot-gate");

/** What a real `checkBotId()` resolves to, with only the field this reads set. */
function verdict(isBot: boolean) {
  return {
    bypassed: false,
    isBot,
    isHuman: !isBot,
    isVerifiedBot: false,
  };
}

describe("isBotRequest", () => {
  beforeEach(() => {
    checkBotIdMock.mockReset();
    vi.useRealTimers();
  });

  it("honours a positive verdict from a service that answered", async () => {
    checkBotIdMock.mockResolvedValue(verdict(true));

    expect(await isBotRequest()).toBe(true);
  });

  it("passes a human verdict through", async () => {
    checkBotIdMock.mockResolvedValue(verdict(false));

    expect(await isBotRequest()).toBe(false);
  });

  /**
   * The two documented throws — `VERCEL_OIDC_TOKEN is not set`, and the
   * missing-request-context one — plus anything `api.vercel.com` does to the
   * unguarded `fetch` inside. Unguarded, each of these 500s every chat
   * message and every OAuth token exchange alike, so a degraded
   * bot-protection service takes sign-in down with it. Fail-open is the
   * deliberate posture; see `bot-gate.ts` for the argument.
   */
  it.each([
    ["VERCEL_OIDC_TOKEN is not set"],
    ["Must be deployed on Vercel to access response headers"],
    ["fetch failed"],
  ])("fails open when checkBotId throws %s", async (message) => {
    checkBotIdMock.mockRejectedValue(new Error(message));

    expect(await isBotRequest()).toBe(false);
  });

  it("fails open rather than waiting indefinitely on a hung check", async () => {
    vi.useFakeTimers();

    // Never settles — a bot-protection service that accepted the connection
    // and then stopped answering. Without the race this hangs the request,
    // and the streamed turn behind it, for as long as the platform allows.
    checkBotIdMock.mockReturnValue(new Promise(() => undefined));

    const pending = isBotRequest();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await pending).toBe(false);
    vi.useRealTimers();
  });

  it("treats a verdict-shaped answer with no isBot field as not-a-bot", async () => {
    checkBotIdMock.mockResolvedValue({});

    expect(await isBotRequest()).toBe(false);
  });
});
