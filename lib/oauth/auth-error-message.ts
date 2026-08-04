import { isOAuthError } from "@ai-oauth-sdk/browser";

/** A message this long, or one that looks like markup, is not fit to show. */
function unsafeToDisplay(text: string): boolean {
  return text.length > 160 || /<[a-z][^>]*>/i.test(text);
}

function shown(text: string): string {
  return unsafeToDisplay(text)
    ? "Something went wrong. Please try again."
    : text;
}

/**
 * `device_flow_failed` is the one SDK error built from a truncated snippet of
 * whatever the token endpoint returned, which is HTML when a gateway answers.
 */
function deviceFlowMessage(status: number | undefined): string {
  return status
    ? `The provider had trouble completing this request (HTTP ${status}). Try again.`
    : "The provider had trouble completing this request. Try again.";
}

/**
 * The SDK builds this message by naming `provider.tokenUrl`, which here is our
 * proxy route rather than anything a reader has heard of. Claude answers a
 * rejected code with `429`, so "try again" immediately keeps the limit hot.
 */
function tokenRequestMessage(status: number | undefined): string {
  if (status === 429) {
    return "The provider is rate-limiting this code exchange. Wait a minute before trying again — repeated attempts keep the limit in place, and each one needs a fresh code.";
  }

  return status
    ? `The provider rejected this code (HTTP ${status}). Click Retry, then use the code from the tab that opens.`
    : "The provider rejected this code. Click Retry, then use the code from the tab that opens.";
}

/**
 * `aborted` is checked before anything logs: it fires on every ordinary cancel,
 * and `use-provider-auth`'s `asCancellation` guarantees cancellation arrives in
 * that one shape. Never classify it by inspecting the error again.
 */
export function errorMessage(error: unknown): string {
  if (isOAuthError(error)) {
    if (error.code === "aborted") {
      return "Cancelled.";
    }

    console.error(error);

    if (error.code === "device_flow_failed") {
      return deviceFlowMessage(error.status);
    }

    if (error.code === "token_request_failed") {
      return tokenRequestMessage(error.status);
    }

    return shown(error.message);
  }

  if (error instanceof Error && error.message) {
    console.error(error);

    return shown(error.message);
  }

  return "Something went wrong. Please try again.";
}
