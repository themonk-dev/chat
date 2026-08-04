import { beforeEach, describe, expect, it, vi } from "vitest";
import { readProjectId, resolveGeminiProject } from "./gemini-project";

describe("readProjectId", () => {
  it("reads the bare-string shape loadCodeAssist returns", () => {
    expect(readProjectId("proj-123")).toBe("proj-123");
  });

  it("reads the {id} shape onboardUser returns", () => {
    expect(readProjectId({ id: "proj-456" })).toBe("proj-456");
  });

  it("returns undefined for an empty string", () => {
    expect(readProjectId("")).toBeUndefined();
  });

  it("returns undefined for an object with no id", () => {
    expect(readProjectId({})).toBeUndefined();
  });

  it("returns undefined for null and undefined", () => {
    expect(readProjectId(null)).toBeUndefined();
    expect(readProjectId(undefined)).toBeUndefined();
  });
});

describe("resolveGeminiProject", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns the project immediately when loadCodeAssist already has one", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ cloudaicompanionProject: "proj-existing" })
    );

    const project = await resolveGeminiProject(
      "token-a",
      undefined,
      fetchImpl as unknown as typeof fetch
    );

    expect(project).toBe("proj-existing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/upstream/gemini/v1internal:loadCodeAssist",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("onboards when loadCodeAssist has no project, and reports status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ allowedTiers: [{ id: "free-tier", isDefault: true }] })
      )
      .mockResolvedValueOnce(
        Response.json({
          done: true,
          response: { cloudaicompanionProject: { id: "proj-onboarded" } },
        })
      );

    const statuses: string[] = [];

    const project = await resolveGeminiProject(
      "token-b",
      (message) => statuses.push(message),
      fetchImpl as unknown as typeof fetch
    );

    expect(project).toBe("proj-onboarded");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "/api/upstream/gemini/v1internal:onboardUser",
      expect.objectContaining({ method: "POST" })
    );
    expect(statuses).toEqual([
      "Checking your Code Assist access…",
      "Setting up a Code Assist project — this happens once…",
    ]);
  });

  it("caches the resolved project per access token", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ cloudaicompanionProject: "proj-cached" })
    );

    await resolveGeminiProject(
      "token-c",
      undefined,
      fetchImpl as unknown as typeof fetch
    );
    await resolveGeminiProject(
      "token-c",
      undefined,
      fetchImpl as unknown as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when the endpoint answers with an error status", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(
      resolveGeminiProject(
        "token-d",
        undefined,
        fetchImpl as unknown as typeof fetch
      )
    ).rejects.toThrow(/Code Assist loadCodeAssist answered 500/);
  });
});
