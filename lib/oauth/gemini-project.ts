/**
 * Every Code Assist call has to name a Cloud project. `loadCodeAssist` returns
 * one for an onboarded account; otherwise `onboardUser` provisions a free-tier
 * project, asynchronously, so the result has to be polled.
 */

import { BoundedMap } from "@/lib/bounded-map";
import { assertBrowser } from "./browser-only";

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

const ONBOARD_POLL_ATTEMPTS = 10;
const ONBOARD_POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded like `copilotCredentials`: a refresh mints a new key, and only the
 * newest is ever read again. */
const PROJECT_CACHE_LIMIT = 4;

/** One resolution per token; onboarding then runs at most once per session. */
const projectCache = new BoundedMap<string, string>(PROJECT_CACHE_LIMIT);

/**
 * The two endpoints disagree: `loadCodeAssist` answers with a bare string,
 * `onboardUser` with `{ id }`.
 */
export function readProjectId(value: unknown): string | undefined {
  if (typeof value === "string" && value) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const { id } = value as { id?: unknown };

    if (typeof id === "string" && id) {
      return id;
    }
  }
}

type CodeAssistResponse = {
  allowedTiers?: { id?: string; isDefault?: boolean }[];
  cloudaicompanionProject?: unknown;
  done?: boolean;
  response?: { cloudaicompanionProject?: unknown };
};

async function callCodeAssist(
  accessToken: string,
  method: string,
  body: unknown,
  fetchImpl: typeof fetch
): Promise<CodeAssistResponse> {
  const response = await fetchImpl(
    `/api/upstream/gemini/v1internal:${method}`,
    {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      method: "POST",
    }
  );

  if (!response.ok) {
    throw new Error(
      `Code Assist ${method} answered ${response.status}: ${await response.text()}`
    );
  }

  return (await response.json()) as CodeAssistResponse;
}

async function onboard(
  accessToken: string,
  load: CodeAssistResponse,
  onStatus: ((message: string) => void) | undefined,
  fetchImpl: typeof fetch
): Promise<string> {
  const tierId =
    load.allowedTiers?.find((tier) => tier.isDefault)?.id ?? "free-tier";
  const body = {
    cloudaicompanionProject: undefined,
    metadata: CODE_ASSIST_METADATA,
    tierId,
  };

  onStatus?.("Setting up a Code Assist project — this happens once…");

  let operation = await callCodeAssist(
    accessToken,
    "onboardUser",
    body,
    fetchImpl
  );

  for (
    let attempt = 0;
    !operation.done && attempt < ONBOARD_POLL_ATTEMPTS;
    attempt += 1
  ) {
    onStatus?.(
      `Waiting for Google to finish provisioning… (${attempt + 1}/${ONBOARD_POLL_ATTEMPTS})`
    );
    // biome-ignore lint/performance/noAwaitInLoops: each poll must wait for the previous one before deciding whether to poll again
    await sleep(ONBOARD_POLL_INTERVAL_MS);
    operation = await callCodeAssist(
      accessToken,
      "onboardUser",
      body,
      fetchImpl
    );
  }

  const project = readProjectId(operation.response?.cloudaicompanionProject);

  if (!project) {
    throw new Error("Gemini onboarding did not return a project id.");
  }

  return project;
}

/**
 * `onStatus` reports progress because onboarding a fresh account polls for up
 * to twenty seconds, and silence that long reads as a hang. Browser-only for
 * the same reason as `copilotCredentialFor`.
 */
export async function resolveGeminiProject(
  accessToken: string,
  onStatus?: (message: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  assertBrowser("Gemini Code Assist project resolution");

  const cached = projectCache.get(accessToken);

  if (cached) {
    return cached;
  }

  onStatus?.("Checking your Code Assist access…");

  const load = await callCodeAssist(
    accessToken,
    "loadCodeAssist",
    { metadata: CODE_ASSIST_METADATA },
    fetchImpl
  );

  const existing = readProjectId(load.cloudaicompanionProject);
  const project =
    existing ?? (await onboard(accessToken, load, onStatus, fetchImpl));

  projectCache.set(accessToken, project);

  return project;
}
