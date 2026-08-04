export type ErrorType =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limit"
  | "offline";

export type Surface =
  | "chat"
  | "auth"
  | "api"
  | "stream"
  | "database"
  | "history"
  | "vote"
  | "document"
  | "suggestions"
  | "activate_gateway";

export type ErrorCode = `${ErrorType}:${Surface}`;

export type ErrorVisibility = "response" | "log" | "none";

export const visibilityBySurface: Record<Surface, ErrorVisibility> = {
  activate_gateway: "response",
  api: "response",
  auth: "response",
  chat: "response",
  database: "log",
  document: "response",
  history: "response",
  stream: "response",
  suggestions: "response",
  vote: "response",
};

export class ChatbotError extends Error {
  type: ErrorType;
  surface: Surface;
  statusCode: number;

  constructor(errorCode: ErrorCode, cause?: string | ErrorOptions) {
    const message = getMessageByErrorCode(errorCode);
    const options = typeof cause === "string" ? undefined : cause;

    super(message, options);

    const [type, surface] = errorCode.split(":");

    this.type = type as ErrorType;
    if (typeof cause === "string") {
      this.cause = cause;
    }
    this.surface = surface as Surface;
    this.statusCode = getStatusCodeByType(this.type);
  }

  toResponse() {
    const code: ErrorCode = `${this.type}:${this.surface}`;
    const visibility = visibilityBySurface[this.surface];

    const { message, cause, statusCode } = this;

    if (visibility === "log") {
      console.error({
        cause,
        code,
        message,
      });

      return Response.json(
        { code: "", message: "Something went wrong. Please try again later." },
        { status: statusCode }
      );
    }

    return Response.json({ cause, code, message }, { status: statusCode });
  }
}

/**
 * A failed send, in the words of whoever actually knew what went wrong.
 *
 * `detail` is the provider's own sentence — "You have exhausted your capacity
 * on this model" — never a paraphrase of it. `kind` is the error's class name
 * when that name says something a reader or a bug report can use
 * (`AI_APICallError`), and `undefined` when it is the bare `Error` every
 * thrown value shares.
 */
export type SendFailure = {
  detail: string;
  kind: string | undefined;
};

/**
 * Shown only when nothing anywhere in the chain had a message. Deliberately
 * not "Something went wrong": it says which part of the exchange is missing,
 * so a reader can tell it apart from a request that was never made.
 */
const UNEXPLAINED = "The provider ended the request without saying why.";

/** Deep enough for `RetryError -> APICallError -> TypeError`, and not endless. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The real error is rarely the outermost one.
 *
 * A quota rejection surfaces as `AI_NoOutputGeneratedError` wrapping
 * `AI_RetryError` wrapping the three `AI_APICallError`s that were actually
 * answered by the provider — and only the innermost of those carries the
 * sentence worth reading. The SDK's `RetryError` hangs its attempts off
 * `lastError` rather than `cause`, so both links are followed.
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

/** `AI_APICallError` is worth showing; a bare `Error` is not. */
function informativeKind(name: string): string | undefined {
  const trimmed = name.trim();

  return trimmed && trimmed !== "Error" ? trimmed : undefined;
}

/**
 * The SDK's own class names, as they survive a trip through a stream.
 *
 * A failure that happens *mid-stream* cannot reach the UI as the error that
 * caused it: the AI SDK serialises it to one string (`errorText`) and
 * `processUIMessageStream` rebuilds it as `new Error(thatText)` — a plain
 * `Error`, class name gone. A string is the only channel the two ends share,
 * so `transport.ts` writes the label into it with `labelledFailureText` and
 * this reads it back out. That is what lets a mid-stream failure and a thrown
 * one describe themselves identically, instead of one of them quietly
 * dropping a field.
 *
 * Deliberately narrow: only the SDK's own `AI_`-prefixed names are recognised,
 * so a provider sentence that merely contains a colon — "Error: quota exceeded
 * for project x" — is left exactly as it was written.
 */
const LABELLED = /^(AI_[A-Za-z]+): ([\s\S]+)$/;

/** The inverse of the parse above; see `LABELLED`. */
export function labelledFailureText(failure: SendFailure): string {
  return failure.kind ? `${failure.kind}: ${failure.detail}` : failure.detail;
}

/**
 * What to tell the reader about a send that failed, derived from the error
 * itself rather than from a table of codes.
 *
 * A thrown string (or anything else non-`Error`) is taken at face value —
 * something that reached this point carrying words is more useful than the
 * fallback, whatever its type.
 */
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

/** Splits a `labelledFailureText` string back into its two halves. */
function labelled(text: string): SendFailure {
  const match = LABELLED.exec(text);

  return match
    ? { detail: match[2].trim(), kind: match[1] }
    : { detail: text, kind: undefined };
}

export function getMessageByErrorCode(errorCode: ErrorCode): string {
  if (errorCode.includes("database")) {
    return "An error occurred while executing a database query.";
  }

  switch (errorCode) {
    case "bad_request:api":
      return "The request couldn't be processed. Please check your input and try again.";

    case "bad_request:activate_gateway":
      return "AI Gateway requires a valid credit card on file to service requests. Please visit https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%3Fmodal%3Dadd-credit-card to add a card and unlock your free credits.";

    case "unauthorized:auth":
      return "You need to sign in before continuing.";
    case "forbidden:auth":
      return "Your account does not have access to this feature.";

    case "rate_limit:chat":
      return "You've reached the message limit. Come back in 1 hour to continue chatting.";
    case "not_found:chat":
      return "The requested chat was not found. Please check the chat ID and try again.";
    case "forbidden:chat":
      return "This chat belongs to another user. Please check the chat ID and try again.";
    case "unauthorized:chat":
      return "You need to sign in to view this chat. Please sign in and try again.";
    case "offline:chat":
      return "We're having trouble sending your message. Please check your internet connection and try again.";

    case "not_found:document":
      return "The requested document was not found. Please check the document ID and try again.";
    case "forbidden:document":
      return "This document belongs to another user. Please check the document ID and try again.";
    case "unauthorized:document":
      return "You need to sign in to view this document. Please sign in and try again.";
    case "bad_request:document":
      return "The request to create or update the document was invalid. Please check your input and try again.";

    default:
      return "Something went wrong. Please try again later.";
  }
}

function getStatusCodeByType(type: ErrorType) {
  switch (type) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "rate_limit":
      return 429;
    case "offline":
      return 503;
    default:
      return 500;
  }
}
