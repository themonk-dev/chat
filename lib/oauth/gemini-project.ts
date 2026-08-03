/**
 * Resolves a Gemini OAuth token to a Code Assist project id.
 *
 * A gemini-cli sign-in grants access to Google's Code Assist API, and every
 * call on that surface — including a chat turn — has to name a Cloud project.
 * `loadCodeAssist` returns one for an account already onboarded;
 * otherwise `onboardUser` provisions a managed (free-tier) project and the
 * result has to be polled, since provisioning is asynchronous on Google's
 * side.
 */

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

const ONBOARD_POLL_ATTEMPTS = 10;
const ONBOARD_POLL_INTERVAL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One resolution per token; onboarding then runs at most once per session. */
const projectCache = new Map<string, string>();

/**
 * The project id, whichever way Code Assist chose to send it.
 *
 * The two endpoints disagree: `loadCodeAssist` returns
 * `cloudaicompanionProject` as a bare string for an account that is already
 * onboarded, while `onboardUser` returns `{ id }` for one it has just
 * provisioned. Reading only the string form would report a successful
 * onboarding as a failure — the project exists, only the wrong shape was
 * checked for.
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
 * Resolves and caches a Code Assist project id for the given access token.
 *
 * `onStatus` is called at each stage so a caller can surface progress —
 * onboarding a fresh account polls for up to twenty seconds, and silence for
 * that long reads as a hang.
 */
export async function resolveGeminiProject(
  accessToken: string,
  onStatus?: (message: string) => void,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
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
