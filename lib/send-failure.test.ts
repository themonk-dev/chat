import { describe, expect, it } from "vitest";
import { describeSendFailure, labelledFailureText } from "./send-failure";

/**
 * The provider's own sentence is the only part of a failure a reader can act
 * on, and it is never the outermost error's message. The live failure that
 * prompted this arrived as `AI_NoOutputGeneratedError` -> `AI_RetryError` ->
 * three `AI_APICallError`s, where only the innermost said "You have exhausted
 * your capacity on this model" — i.e. only the innermost said "pick another
 * model", which is the whole of what the reader needed.
 */

/** How the AI SDK's errors are shaped, without importing the SDK to build one. */
function aiError(
  name: string,
  message: string,
  links: { cause?: unknown; lastError?: unknown } = {}
): Error {
  return Object.assign(new Error(message), { name, ...links });
}

describe("describeSendFailure", () => {
  it("keeps the provider's own words rather than paraphrasing them", () => {
    const quota = aiError(
      "AI_APICallError",
      "You have exhausted your capacity on this model"
    );

    expect(describeSendFailure(quota)).toEqual({
      detail: "You have exhausted your capacity on this model",
      kind: "AI_APICallError",
    });
  });

  /**
   * `RetryError` hangs the attempt it gave up on off `lastError`, not `cause`,
   * so a chain walker that only follows `cause` stops at "No output
   * generated." — technically true and completely useless.
   */
  it("digs the real explanation out from under the retry wrapper", () => {
    const failure = aiError(
      "AI_NoOutputGeneratedError",
      "No output generated.",
      {
        cause: aiError("AI_RetryError", "Failed after 3 attempts", {
          lastError: aiError(
            "AI_APICallError",
            "You have exhausted your capacity on this model"
          ),
        }),
      }
    );

    expect(describeSendFailure(failure)).toEqual({
      detail: "You have exhausted your capacity on this model",
      kind: "AI_APICallError",
    });
  });

  /**
   * The mid-stream path: the SDK turns an `{type: "error"}` chunk into a plain
   * `new Error(chunk.errorText)`, whose name is the bare "Error". The text is
   * still the provider's, so it is still what gets shown — but "Error" tells a
   * reader nothing and is dropped.
   */
  it("shows a bare Error's message without labelling it 'Error'", () => {
    expect(
      describeSendFailure(new Error("Upstream closed the stream"))
    ).toEqual({ detail: "Upstream closed the stream", kind: undefined });
  });

  /**
   * The mid-stream round trip, end to end. The transport labels the text on
   * the way into the stream because the SDK carries nothing else across it,
   * and the far end has to come out where a thrown error of the same kind
   * would — otherwise one of the two paths renders a field the other doesn't.
   */
  it("recovers the class name a stream could only carry as text", () => {
    const quota = aiError(
      "AI_APICallError",
      "You have exhausted your capacity on this model"
    );
    const overTheWire = new Error(
      labelledFailureText(describeSendFailure(quota))
    );

    expect(describeSendFailure(overTheWire)).toEqual(
      describeSendFailure(quota)
    );
  });

  /** A provider sentence that merely contains a colon is not a label. */
  it("leaves an ordinary colon in the provider's own words alone", () => {
    expect(
      describeSendFailure(new Error("Error: quota exceeded for project x"))
    ).toEqual({
      detail: "Error: quota exceeded for project x",
      kind: undefined,
    });
  });

  it("takes a thrown string at its word", () => {
    expect(describeSendFailure("Connect OpenRouter first.")).toEqual({
      detail: "Connect OpenRouter first.",
      kind: undefined,
    });
  });

  /** Only when genuinely nothing said anything — and even then, not "Something went wrong". */
  it("says which part of the exchange is missing when nothing explained itself", () => {
    // Assigned rather than constructed: an empty `new Error("")` is itself a
    // lint error, and what has to be covered is an error that *arrives* blank.
    const silent = aiError("AI_APICallError", "placeholder");
    silent.message = "";

    expect(describeSendFailure(silent).detail).toBe(
      "The provider ended the request without saying why."
    );
  });

  /** A cycle in `cause` must not hang the render it is about to feed. */
  it("survives an error that causes itself", () => {
    const looping = aiError("AI_APICallError", "Upstream refused");
    (looping as { cause?: unknown }).cause = looping;

    expect(describeSendFailure(looping).detail).toBe("Upstream refused");
  });
});
