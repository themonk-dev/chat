import { describe, expect, it } from "vitest";
import { resolveTarget, withQuery } from "./targets";

describe("resolveTarget", () => {
  it("resolves a provider's token endpoint", () => {
    expect(resolveTarget("token", "claude", [])?.href).toBe(
      "https://platform.claude.com/v1/oauth/token"
    );
  });

  it("joins a path below the provider's API base", () => {
    expect(resolveTarget("upstream", "claude", ["messages"])?.href).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });

  it("passes a colon through unescaped, because Code Assist needs it", () => {
    expect(
      resolveTarget("upstream", "gemini", ["v1internal:loadCodeAssist"])?.href
    ).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist");
  });

  it("refuses to climb out of the base", () => {
    expect(
      resolveTarget("upstream", "claude", ["..", "..", "admin"])
    ).toBeUndefined();
  });

  it("refuses an encoded traversal", () => {
    expect(
      resolveTarget("upstream", "claude", ["%2e%2e", "admin"])
    ).toBeUndefined();
  });

  it("refuses an unknown provider", () => {
    expect(resolveTarget("token", "not-a-provider", [])).toBeUndefined();
  });

  it("refuses an unknown kind", () => {
    expect(resolveTarget("elsewhere", "claude", [])).toBeUndefined();
  });

  it("lets the descriptor's own query win over the caller's", () => {
    const target = new URL("https://example.test/api?client_version=1");
    const merged = withQuery(
      target,
      new URL("https://page.test/x?client_version=9&extra=2")
    );
    expect(merged.searchParams.get("client_version")).toBe("1");
    expect(merged.searchParams.get("extra")).toBe("2");
  });
});
