/**
 * A failed send in the provider's own words. `detail` is never a paraphrase;
 * `kind` is the error's class name when it says something useful.
 */
export type SendFailure = {
  detail: string;
  kind: string | undefined;
};

const UNEXPLAINED = "The provider ended the request without saying why.";

/** Deep enough for `RetryError -> APICallError -> TypeError`, and not endless. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The SDK serialises a mid-stream failure to one string and rebuilds it as a
 * plain `Error`, so the class name travels folded into the message text.
 */
const LABELLED = /^(AI_[A-Za-z]+): ([\s\S]+)$/;

/**
 * The sentence worth reading is the innermost one, and `RetryError` hangs its
 * attempts off `lastError` rather than `cause`.
 */
function unwrap(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;

  while (current instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);

    const { lastError } = current as { lastError?: unknown };
    const next = lastError ?? current.cause;

    if (next === current) {
      break;
    }

    current = next;
  }

  return chain;
}

function informativeKind(name: string): string | undefined {
  const trimmed = name.trim();

  return trimmed && trimmed !== "Error" ? trimmed : undefined;
}

function labelled(text: string): SendFailure {
  const match = LABELLED.exec(text);

  return match
    ? { detail: match[2].trim(), kind: match[1] }
    : { detail: text, kind: undefined };
}

export function labelledFailureText(failure: SendFailure): string {
  return failure.kind ? `${failure.kind}: ${failure.detail}` : failure.detail;
}

export function describeSendFailure(error: unknown): SendFailure {
  if (typeof error === "string" && error.trim()) {
    return labelled(error.trim());
  }

  const deepestFirst = unwrap(error).reverse();
  const explained = deepestFirst.find((link) => link.message.trim());

  if (!explained) {
    return { detail: UNEXPLAINED, kind: undefined };
  }

  const kind = informativeKind(explained.name);

  return kind
    ? { detail: explained.message.trim(), kind }
    : labelled(explained.message.trim());
}
