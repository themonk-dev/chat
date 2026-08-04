import { OAuthError } from "@ai-oauth-sdk/browser";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useCallback, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderAuthProvider,
  useProviderAuth,
} from "@/hooks/use-provider-auth";
import { clientFor } from "@/lib/oauth/storage";
import { AuthDialog } from "./auth-dialog";

vi.mock("@/lib/oauth/storage", () => ({
  clientFor: vi.fn(),
  tokenStorage: {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(() => undefined, {
    error: () => undefined,
    success: () => undefined,
  }),
}));

vi.mock("usehooks-ts", () => ({
  useCopyToClipboard: () => ["", () => Promise.resolve(true)],
}));

/**
 * What `fetch` rejects with when the signal it was handed aborts while a
 * request is on the wire — a bare `AbortError`, built by the abort machinery
 * rather than by the SDK, which is why no amount of `isOAuthError` sniffing
 * downstream ever recognised it.
 *
 * Deliberately not `new DOMException(...)`: jsdom's `DOMException` descends
 * from the jsdom window's `Error`, not the realm's `Error` this file and the
 * component under test compare against, so `error instanceof Error` is false
 * for it here and true in every browser. Using it would send the dialog down
 * a branch the real bug never took and quietly stop reproducing anything.
 * `errorMessage` reads exactly `instanceof Error`, `name` and `message`, and
 * on all three this is what Chrome hands over.
 */
function abortError(): Error {
  const error = new Error("signal is aborted without reason");

  error.name = "AbortError";

  return error;
}

/** The subset of `AuthClient` the device flow reaches for. */
function makeClient(
  deviceLogin: (options: DeviceLoginOptions) => Promise<never>
) {
  return {
    deviceLogin: vi.fn(deviceLogin),
    getTokens: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  };
}

type DeviceLoginOptions = {
  onCode: (device: { userCode: string; verificationUri: string }) => void;
  signal: AbortSignal;
};

/**
 * A device flow that hands over its code and then never finishes on its own,
 * the way a real one waits on the reader approving it elsewhere — and, when
 * cancelled, rejects the way `fetch` does rather than the way the SDK does.
 * This is the whole reproduction: which of the two shapes a reader gets is a
 * matter of milliseconds (mid-poll versus between polls), and only one of
 * them used to be recognised as cancellation.
 */
function pollingDeviceClient() {
  return makeClient(
    ({ onCode, signal }) =>
      new Promise<never>((_resolve, reject) => {
        onCode({
          userCode: "TCUCZE0G",
          verificationUri: "https://chat.qwen.ai/device",
        });
        signal.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      })
  );
}

/**
 * `manage-providers.tsx` reduced to the two things this reproduction rides
 * on: Connect on a non-active provider moves `activeId` before opening the
 * dialog, and closing the dialog without connecting restores the provider the
 * reader came from. That restore is what calls `setActiveId`, and
 * `setActiveId` is what aborts the attempt still in flight. The popover, the
 * seven rows and the shared connection map the real component also owns have
 * nothing to do with it.
 */
function Harness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previousActiveId, setPreviousActiveId] = useState<
    string | undefined
  >();
  const { activeId, isConnected, setActiveId } = useProviderAuth();

  useEffect(() => {
    if (dialogOpen || previousActiveId === undefined) {
      return;
    }

    if (!isConnected) {
      setActiveId(previousActiveId);
    }

    setPreviousActiveId(undefined);
  }, [dialogOpen, isConnected, previousActiveId, setActiveId]);

  const handleConnect = useCallback(() => {
    setPreviousActiveId(activeId);
    setActiveId("qwen");
    setDialogOpen(true);
  }, [activeId, setActiveId]);

  return (
    <>
      <button data-testid="connect-qwen" onClick={handleConnect} type="button">
        Connect Qwen
      </button>
      <AuthDialog
        key={activeId}
        onOpenChange={setDialogOpen}
        open={dialogOpen}
      />
    </>
  );
}

/** Lets every pending microtask and timer settle inside `act`. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("cancelling a sign-in", () => {
  let logged: unknown[][] = [];

  beforeEach(() => {
    sessionStorage.clear();
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The bug, exactly as a reader hits it: open Connect on Qwen, watch the
   * device code arrive, close the dialog with its X. The restore effect calls
   * `setActiveId`, `setActiveId` aborts the poll, and the poll — being a real
   * request on the wire — rejects with a bare `AbortError` rather than the
   * SDK's own. Closing a dialog is not a failure and must leave nothing
   * behind: no console output, and no unhandled rejection.
   */
  it("leaves nothing in the console when the dialog is closed mid-flight", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);

    process.on("unhandledRejection", onUnhandled);

    try {
      const qwen = pollingDeviceClient();

      vi.mocked(clientFor).mockImplementation(
        (id: string) =>
          (id === "qwen" ? qwen : makeClient(() => Promise.reject())) as never
      );

      render(
        <ProviderAuthProvider>
          <Harness />
        </ProviderAuthProvider>
      );

      fireEvent.click(screen.getByTestId("connect-qwen"));
      await settle();
      expect(screen.getByTestId("device-code").textContent).toBe("TCUCZE0G");

      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await settle();

      expect(qwen.deviceLogin.mock.calls[0][0].signal.aborted).toBe(true);
      expect(logged).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  /**
   * The other half, and the reason cancellation cannot simply be swallowed:
   * a device-code request that genuinely fails was never cancelled, so it
   * still reaches the dialog's error UI in full — a message the reader can
   * act on, a Retry, a Close, and the `console.error` a developer needs.
   */
  it("still reports a device request that genuinely fails", async () => {
    const qwen = makeClient(() =>
      Promise.reject(
        new OAuthError(
          "device_flow_failed",
          "Device authorization request failed (HTTP 502).",
          { status: 502 }
        )
      )
    );

    vi.mocked(clientFor).mockImplementation(
      (id: string) =>
        (id === "qwen" ? qwen : makeClient(() => Promise.reject())) as never
    );

    render(
      <ProviderAuthProvider>
        <Harness />
      </ProviderAuthProvider>
    );

    fireEvent.click(screen.getByTestId("connect-qwen"));
    await settle();

    expect(screen.getByRole("alert").textContent).toBe(
      "The provider had trouble completing this request (HTTP 502). Try again."
    );
    expect(screen.getByTestId("auth-dialog-retry")).toBeTruthy();
    expect(screen.getByTestId("auth-dialog-close")).toBeTruthy();
    expect(logged).toHaveLength(1);
  });
});
