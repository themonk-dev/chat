import { describe, expect, it } from "vitest";
import { CLAUDE_SYSTEM, modelFor } from "./adapters";

describe("CLAUDE_SYSTEM", () => {
  it("is the exact prompt Claude's OAuth-scoped Messages API requires", () => {
    // The Messages API checks this string, not merely its presence — copied
    // verbatim from the old playground's CLAUDE_SYSTEM constant. A refusal
    // ("only authorized for use with Claude Code") almost always means this
    // drifted.
    expect(CLAUDE_SYSTEM).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude."
    );
  });
});

describe("modelFor", () => {
  it("rejects a provider id none of the seven adapters handle", async () => {
    await expect(modelFor("not-a-provider", "model", "token")).rejects.toThrow(
      "No adapter yet for provider: not-a-provider"
    );
  });
});
