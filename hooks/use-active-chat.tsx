"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import { useChat } from "@ai-sdk/react";
import { usePathname } from "next/navigation";
import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDataStream } from "@/components/chat/data-stream-provider";
import { toast } from "@/components/chat/toast";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { deleteChat, readChat, writeChat } from "@/lib/chats/store";
import { ChatbotError, describeSendFailure } from "@/lib/errors";
import { defaultModelFor, modelNameFor } from "@/lib/oauth/models";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";
import { clientFor } from "@/lib/oauth/storage";
import { OAuthChatTransport } from "@/lib/oauth/transport";
import type { ChatMessage } from "@/lib/types";
import { generateUUID } from "@/lib/utils";

type ActiveChatContextValue = {
  chatId: string;
  messages: ChatMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage: UseChatHelpers<ChatMessage>["sendMessage"];
  status: UseChatHelpers<ChatMessage>["status"];
  stop: UseChatHelpers<ChatMessage>["stop"];
  regenerate: UseChatHelpers<ChatMessage>["regenerate"];
  addToolApprovalResponse: UseChatHelpers<ChatMessage>["addToolApprovalResponse"];
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  isLoading: boolean;
  currentModelId: string;
  /**
   * `providerId` is optional so every existing one-argument call site (and
   * the auto-recovery below, which already knows only the model id it wants)
   * keeps working: it defaults to whichever provider is active right now.
   * The model picker in `multimodal-input.tsx` always passes it explicitly,
   * because that is the one call site where "the provider the model came
   * from" and "the provider that happens to be active" can differ.
   */
  setCurrentModelId: (id: string, providerId?: string) => void;
  clearChat: () => void;
};

/** Tokens for every provider that currently holds one, not just the active one. */
export type ConnectedProviders = Map<string, string>;

/**
 * Bumped whenever a provider's stored tokens are revoked outside the
 * `activeId`/`tokens` pair that `useConnectedProviders` otherwise watches.
 *
 * Disconnecting a provider that is *not* the active one changes neither of
 * those, so without this every connection map in the tree keeps offering a
 * revoked provider's models — and, worse, keeps `nextSelection` answering
 * `"keep"` for a selection whose owner no longer holds a token, which is the
 * second route into the model/provider mismatch below. Rather than have each
 * map maintain its own private idea of who is connected and hope every
 * revoker remembers to tell all of them, revocation goes through
 * `disconnectProvider` and every map re-reads storage.
 */
let connectionsRevision = 0;
const connectionsListeners = new Set<() => void>();

function subscribeConnections(listener: () => void): () => void {
  connectionsListeners.add(listener);

  return () => {
    connectionsListeners.delete(listener);
  };
}

function readConnectionsRevision(): number {
  return connectionsRevision;
}

/**
 * Tells every `useConnectedProviders` in the tree to re-read storage.
 *
 * Nothing is passed along with it deliberately: the notification says only
 * "storage moved", and each map answers by asking storage itself, so a
 * notification can never be the thing that files one provider's token under
 * another provider's id.
 */
export function notifyConnectionsChanged(): void {
  connectionsRevision += 1;

  for (const listener of connectionsListeners) {
    listener();
  }
}

/**
 * Revokes one provider's tokens, wherever that provider sits relative to the
 * active one, and makes sure every connection map hears about it.
 *
 * The refresh happens after `logout()` settles rather than optimistically,
 * and it re-reads storage rather than assuming the logout worked — a logout
 * that failed leaves the token in place, and a map that had already deleted
 * the entry would then be lying in the other direction.
 */
export function disconnectProvider(id: string): Promise<void> {
  return clientFor(id)
    .logout()
    .catch(() => {
      // Storage is re-read below either way; nothing to decide here.
    })
    .then(() => {
      notifyConnectionsChanged();
    });
}

/**
 * Folds a batch of storage answers into the map, returning `previous`
 * untouched when nothing actually changed.
 *
 * Identity matters here: `useModelGroups` re-fetches every connected
 * provider's model list whenever this map's identity changes, and the
 * connection popover now asks for a refresh every time it opens. A refresh
 * that merely confirms what was already known must therefore be invisible
 * downstream, not a new `Map` that looks like news.
 */
function withConnections(
  previous: ConnectedProviders,
  entries: readonly (readonly [string, string | undefined])[]
): ConnectedProviders {
  const next = new Map(previous);

  for (const [id, token] of entries) {
    if (token) {
      next.set(id, token);
    } else {
      next.delete(id);
    }
  }

  if (next.size !== previous.size) {
    return next;
  }

  for (const [id, token] of next) {
    if (previous.get(id) !== token) {
      return next;
    }
  }

  return previous;
}

/**
 * Which providers currently hold a token, independent of which one is
 * active — the question `useProviderAuth` cannot answer, since its `tokens`
 * are scoped to `activeId` by construction.
 *
 * The answer comes in two parts. The *active* provider's entry is kept
 * current reactively (see the first effect below for why that re-reads
 * storage itself rather than trusting `useProviderAuth`'s `tokens`
 * directly); every other provider is invisible to that effect and is read
 * from storage in the full sweep beneath it — on mount, and again whenever
 * `notifyConnectionsChanged` says storage moved.
 *
 * The sweep runs on mount rather than lazily, because every caller needs an
 * answer before any menu is ever opened: the model picker's trigger, the
 * recovery effect below, and the composer's send gate all ask this before
 * the reader has touched anything.
 */
export function useConnectedProviders(): ConnectedProviders {
  const { activeId, tokens } = useProviderAuth();
  const [connected, setConnected] = useState<ConnectedProviders>(new Map());
  const revision = useSyncExternalStore(
    subscribeConnections,
    readConnectionsRevision,
    readConnectionsRevision
  );

  /**
   * Re-reads storage for `activeId` directly rather than trusting `tokens`
   * from `useProviderAuth`. `tokens` genuinely lags `activeId` by a commit:
   * `setActiveId` does not clear it, and `useProviderAuth` only replaces it
   * once its own async `clientFor(activeId).getTokens()` resolves. On the
   * very commit `activeId` changes, `tokens` is still the *previous*
   * provider's `TokenSet` — trusting it here would file that token under the
   * new `activeId`, which is exactly how one provider's OAuth token ends up
   * addressed to another provider's API host two hops downstream, through
   * `fetchModelsFor` -> `GET /api/upstream/<newProvider>/models` carrying
   * the old provider's bearer token.
   *
   * A "does `tokens.provider` match `activeId`" check would catch that
   * mismatch when `tokens` is a stale-but-present `TokenSet`, but not the
   * mirror case: `tokens` genuinely undefined (the previous provider was
   * disconnected) is indistinguishable, by a tag alone, from "no answer yet
   * for the new provider" — and wrongly deleting a *different*, genuinely
   * connected provider's entry is the disconnect-recovery bug (a model
   * picked from a provider that was never touched silently reverting).
   * Re-reading independently sidesteps both: `tokens` stays in the
   * dependency array purely as a trigger — connecting a provider that is
   * already active changes `tokens` without changing `activeId`, and that
   * transition still has to be picked up — but the value written for `id`
   * always comes from asking storage about `id` itself, and a superseded
   * read (`activeId` having moved on again before this one resolves) is
   * dropped rather than applied.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokens is a deliberate trigger-only dependency, not read in the body — see the comment above.
  useEffect(() => {
    let cancelled = false;
    const id = activeId;

    clientFor(id)
      .getTokens()
      .catch(() => undefined)
      .then((found) => {
        if (cancelled) {
          return;
        }
        setConnected((previous) =>
          withConnections(previous, [[id, found?.accessToken]])
        );
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, tokens]);

  /**
   * The full sweep: on mount, and again on every `connectionsRevision` bump,
   * since a revocation elsewhere in the tree can concern any provider — not
   * just the active one the effect above watches.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is a deliberate trigger-only dependency, not read in the body — the answer always comes from storage.
  useEffect(() => {
    let cancelled = false;

    Promise.all(
      PROVIDER_ORDER.map(async (id) => {
        const found = await clientFor(id)
          .getTokens()
          .catch(() => undefined);
        return [id, found?.accessToken] as const;
      })
    ).then((results) => {
      if (cancelled) {
        return;
      }
      setConnected((previous) => withConnections(previous, results));
    });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return connected;
}

/**
 * Which provider `currentModelId` was picked from, mirrored outside React
 * state.
 *
 * `ActiveChatProvider` itself does not remount when the route changes
 * between `/` and `/chat/[id]` — only its descendants do, including
 * `MultimodalInput` and the model picker inside it. A component-local ref
 * in the picker loses the model-to-provider association on every such
 * navigation, even though `currentModelId` itself survives untouched in
 * this provider one level up: the picker would render "Select a model"
 * for a selection that is still live and sendable. A module-level value
 * survives exactly as long as `currentModelId` does, without adding a 15th
 * member to the frozen context contract.
 *
 * `applySelection` (below) is its only writer, and it is the only writer of
 * `currentModelId` too, so this cannot come to describe a different
 * selection than the one on screen.
 */
let lastSelectionProviderId: string | undefined;

/** Read-only outside this module; only `applySelection` writes it. */
export function getSelectionProviderId(): string | undefined {
  return lastSelectionProviderId;
}

export type SelectionOutcome =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "set"; modelId: string; providerId: string };

/**
 * The pure half of the recovery effect below: given the current connection
 * map, the current selection, and which provider that selection belongs to,
 * decides what (if anything) should change. Extracted the same way
 * `shouldPersistChat` was — the effect's job shrinks to applying the
 * decision (writing the ref, the module mirror, `setActiveId`), which is
 * the part that actually needs a DOM/React environment to exercise.
 *
 * `PROVIDER_ORDER` is the fallback order deliberately, not connection
 * recency or any other ordering: it is the same order the provider
 * dropdown lists, so "which provider did the picker fall back to" reads as
 * the same list a reader already understands, not a hidden recency queue.
 */
export function nextSelection({
  connected,
  currentModelId,
  owner,
}: {
  connected: ConnectedProviders;
  currentModelId: string;
  owner: string | undefined;
}): SelectionOutcome {
  const ownerStillConnected = owner !== undefined && connected.has(owner);

  if (currentModelId && ownerStillConnected) {
    return { kind: "keep" };
  }

  const fallback = PROVIDER_ORDER.find((id) => connected.has(id));

  if (fallback) {
    return {
      kind: "set",
      modelId: defaultModelFor(fallback),
      providerId: fallback,
    };
  }

  return currentModelId ? { kind: "clear" } : { kind: "keep" };
}

/** The three things one send is made of, and who they belong to. */
export type ResolvedRequest = {
  accessToken: string | undefined;
  modelId: string;
  providerId: string;
};

/**
 * Decides which provider a send is addressed to, and picks the token to
 * address it with from that same answer.
 *
 * The provider is the model's *owner* — whoever the selection was made from
 * — not whichever provider happens to be active. Those two are not the same
 * thing and are not kept in step on purpose: `nextSelection` returns
 * `"keep"` whenever the owner is still connected, precisely so that merely
 * looking at another provider (or connecting one, which leaves it active)
 * does not disturb a live selection. Pairing `modelId` with `activeId`
 * therefore sends one provider's model slug to another provider's API — a
 * 404 if the slug is unknown there, and silently answered and billed to the
 * wrong account if it is not.
 *
 * The token then comes from `connected`, keyed by that same id, so all three
 * fields are derived from one tag rather than correlated after the fact.
 * `connected` is built by asking storage about each provider *by id*, so its
 * entries cannot be mis-attributed. The `activeAccessToken` fallback covers
 * only the gap right after a fresh connect, where `useProviderAuth` already
 * holds the token but the map's own storage read has not resolved yet; it is
 * safe because it is used only when the owner *is* the active provider, and
 * `useProviderAuth` derives `tokens` from its own provider tag, so an active
 * token that does not belong to `activeId` is never exposed in the first
 * place.
 *
 * An owner with no token yields `undefined`, which the transport turns into
 * "Connect <that provider> before sending this model's messages." — the send
 * fails closed rather than being re-pointed at somebody else.
 *
 * The composer's send gate calls this too, and disables the button on the
 * same `accessToken === undefined`, so that message is a backstop rather
 * than the normal way a reader learns about it.
 */
export function resolveRequest({
  activeAccessToken,
  activeId,
  connected,
  modelId,
  owner,
}: {
  activeAccessToken: string | undefined;
  activeId: string;
  connected: ConnectedProviders;
  modelId: string;
  owner: string | undefined;
}): ResolvedRequest {
  const providerId = owner ?? activeId;

  return {
    accessToken:
      connected.get(providerId) ??
      (providerId === activeId ? activeAccessToken : undefined),
    modelId,
    providerId,
  };
}

/**
 * Turns a failed send into the assistant message that reports it, appended to
 * the transcript it failed in.
 *
 * A separate message rather than a part bolted onto whatever came last:
 * a stream that died halfway leaves a genuine partial reply behind, and that
 * partial is not the error — the reader needs to see both, in the order they
 * happened.
 *
 * The model name comes from `modelNameFor` — the static catalogue, falling back
 * to the raw slug — which is also what the attribution line under a successful
 * reply uses, so the two cannot name the same model differently.
 *
 * The message carries the same `attribution` metadata a successful reply gets,
 * even though this block renders the provider and model from its own part
 * rather than from that metadata. Nothing downstream then has to know that a
 * failure is a special kind of assistant message to answer "who was this
 * addressed to"; and `message.tsx` skips the footnote here precisely because
 * this block already says it, in this same small print.
 *
 * Exported (and pure but for the message id) because everything worth
 * checking about a failure report is here: that the provider's own sentence
 * survives, that the right provider and model are named, and that the retry
 * points at the user's message rather than at the failure.
 */
/**
 * Whether an assistant message would draw nothing on screen.
 *
 * A send opens its assistant message before a single token arrives, so a
 * failure finds one already there with only bookkeeping parts in it —
 * `step-start`, or a text part still empty. Judged by what renders rather than
 * by part count, so a reply that produced real text before dying is never
 * mistaken for an empty one and thrown away.
 */
export function isBlankReply(message: ChatMessage | undefined): boolean {
  if (message?.role !== "assistant") {
    return false;
  }

  return !message.parts.some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }

    return part.type !== "step-start";
  });
}

export function failureMessage({
  error,
  messages,
  modelId,
  providerId,
}: {
  error: unknown;
  messages: readonly ChatMessage[];
  modelId: string;
  providerId: string;
}): ChatMessage {
  const { detail, kind } = describeSendFailure(error);
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return {
    id: generateUUID(),
    metadata: {
      attribution: { modelId, providerId },
      createdAt: new Date().toISOString(),
    },
    parts: [
      {
        data: {
          detail,
          ...(kind ? { kind } : {}),
          modelId,
          modelName: modelNameFor(providerId, modelId),
          providerId,
          providerLabel: registry[providerId]?.label ?? providerId,
          ...(lastUserMessage ? { retryOf: lastUserMessage.id } : {}),
        },
        type: "data-error",
      },
    ],
    role: "assistant",
  };
}

const ActiveChatContext = createContext<ActiveChatContextValue | null>(null);

function extractChatId(pathname: string): string | null {
  const match = pathname.match(/\/chat\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * The transcript exactly as it would be stored. Nothing cheaper is safe:
 * every abbreviation tried here has been a bug. A message count misses a
 * change that keeps the length (clear-then-send, edit-and-regenerate); a
 * sequence of message ids misses a change that keeps the ids, which is what
 * `addToolApprovalResponse` does — it rewrites the last message's `parts` in
 * place via `replaceMessage(messages.length - 1, { ...lastMessage, parts })`,
 * so denying a tool call produces an identical id sequence of identical
 * length and only the part's `state`/`approval` differ.
 *
 * `JSON.stringify` is the right comparison specifically because it is what
 * `writeChat` serialises with: two transcripts with the same signature would
 * produce the same bytes in `localStorage`, so skipping the write is exactly
 * a no-op, and anything that would change those bytes is seen. Stored
 * messages come back through `JSON.parse` of that same text, so key order —
 * which `JSON.stringify` preserves from insertion order — round-trips
 * faithfully and merely opening a thread still compares equal.
 */
function transcriptSignature(messages: readonly unknown[]): string {
  return JSON.stringify(messages);
}

/**
 * Loading a stored thread hands `useChat` a non-empty `messages` array and a
 * `status` of `"ready"` immediately — the same shape as a real reply having
 * just finished. Comparing against a hand-maintained "last persisted count"
 * used to guard against that, but a count is derived state: anything that
 * changes `messages` without touching `chatId` (clearing, editing a message
 * and regenerating) can desynchronise it, and a count collision then makes a
 * real exchange silently fail to persist — self-healing on the next
 * differing count, which makes it nasty to notice.
 *
 * Comparing the live transcript against what is actually stored for this
 * thread has no state to desynchronise, and comparing its *content* rather
 * than its shape leaves nothing for a change to hide behind: it is correct
 * for opening a thread (the bytes match what was just loaded from the same
 * place), for a genuine send or completed reply, for the same-count cases,
 * and for an in-place rewrite such as a denied tool approval.
 *
 * The cost is a full serialisation of the thread, which is affordable
 * because of where this sits: the `status !== "ready"` gate above rejects
 * every render during streaming, and `messages` is unrelated to the input
 * textbox, so this runs once per settled turn — not per keystroke.
 */
/**
 * The two statuses at which the transcript is finished moving.
 *
 * `"error"` belongs here as squarely as `"ready"` does, and leaving it out was
 * why a failed exchange vanished on reload: the reader's question had been
 * asked, the URL said `/chat/<id>`, and nothing was ever written for that id —
 * so the thread was not merely unexplained, it was gone. Nothing is streaming
 * in the `"error"` state either, so persisting there stores a settled
 * transcript for exactly the same reason `"ready"` does, failure report and
 * all.
 */
const SETTLED_STATUSES = new Set(["ready", "error"]);

export function shouldPersistChat({
  status,
  messages,
  storedMessages,
}: {
  status: string;
  messages: readonly unknown[];
  storedMessages: readonly unknown[];
}): boolean {
  if (!SETTLED_STATUSES.has(status) || messages.length === 0) {
    return false;
  }

  try {
    return (
      transcriptSignature(messages) !== transcriptSignature(storedMessages)
    );
  } catch {
    /*
     * A transcript that will not serialise cannot be compared, and would not
     * survive `writeChat` either. Answering "yes, write" keeps the failure in
     * one place — the store's own guarded write — rather than adding a second
     * silent way to lose a turn.
     */
    return true;
  }
}

/**
 * Owns the whole persistence decision: reads what is actually stored for
 * `chatId` and writes only when the live transcript differs from it. Takes
 * plain values rather than pulling from `useChat` itself so it can be driven
 * directly in a test — chatId/messages/status in, a write (or not) out —
 * without needing to stand up a real chat session.
 */
export function usePersistChat({
  chatId,
  messages,
  status,
}: {
  chatId: string;
  messages: ChatMessage[];
  status: string;
}): void {
  useEffect(() => {
    if (!SETTLED_STATUSES.has(status) || messages.length === 0) {
      return;
    }

    const storedMessages = readChat(chatId)?.messages ?? [];

    if (!shouldPersistChat({ messages, status, storedMessages })) {
      return;
    }

    const first = messages.find((message) => message.role === "user");
    const title =
      first?.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .slice(0, 60) || "New chat";

    writeChat({ id: chatId, messages, title, updatedAt: Date.now() });
  }, [chatId, messages, status]);
}

export function ActiveChatProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { setDataStream, setWaitingStatus } = useDataStream();

  const chatIdFromUrl = extractChatId(pathname);
  const isNewChat = !chatIdFromUrl;
  const newChatIdRef = useRef(generateUUID());
  const prevPathnameRef = useRef(pathname);

  if (isNewChat && prevPathnameRef.current !== pathname) {
    newChatIdRef.current = generateUUID();
  }
  prevPathnameRef.current = pathname;

  const chatId = chatIdFromUrl ?? newChatIdRef.current;

  /**
   * Starts empty rather than on any hard-coded model: with nothing connected
   * there is nothing to offer, and an empty picker is the honest state, not
   * a broken one. The effect below fills it in the moment a provider's
   * tokens are found, and keeps it pointed at something usable after that.
   */
  const [currentModelId, setCurrentModelIdState] = useState("");

  /**
   * The selection as one value — which model, and which provider it was
   * picked from — rather than two refs that happen to be kept in step.
   *
   * They were two, and the two moved differently: the model id was mirrored
   * from state inside an effect while the owner was written synchronously,
   * so between a selection changing and React flushing passive effects the
   * pair described a model that had never been picked from that provider.
   * That is the whole bug class this branch keeps meeting — a provider id
   * correlated with something by timing instead of carried on it — and no
   * comment promising the two "move in lockstep" makes it structural.
   * One object, written by `applySelection` alone, does: there is no way to
   * set the model without saying whose it is.
   *
   * It leads `currentModelId` by a render rather than lagging it, which is
   * the right direction for the only reader that matters — the transport
   * resolver, consulted at send time, long after the write.
   */
  const selectionRef = useRef<{
    modelId: string;
    providerId: string | undefined;
  }>({ modelId: "", providerId: undefined });

  const { activeId, tokens, setActiveId } = useProviderAuth();
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  const tokensRef = useRef(tokens);
  useEffect(() => {
    tokensRef.current = tokens;
  }, [tokens]);

  /**
   * The one writer of the selection, for all three of its homes: the ref
   * above (what the recovery effect and the transport resolver read back),
   * the module-level mirror (what components outside this provider read,
   * across remounts this component does not undergo), and the state that
   * renders it. Nothing else assigns any of them, so they cannot describe
   * different selections.
   */
  const applySelection = useCallback(
    (modelId: string, providerId: string | undefined) => {
      selectionRef.current = { modelId, providerId };
      lastSelectionProviderId = providerId;
      setCurrentModelIdState(modelId);
    },
    []
  );

  /**
   * `providerId` defaults to whichever provider is active right now, which
   * is exactly right for every call this file makes itself (the recovery
   * effect below always sets a model for the provider it just decided is
   * active). The model picker passes it explicitly instead, because
   * selecting a model there also switches the active provider to match — by
   * the time this runs, `activeId` may already have moved on to a *third*
   * provider if the reader clicked twice quickly, so the picker cannot rely
   * on it and threads the real answer through instead.
   */
  const setCurrentModelId = useCallback(
    (id: string, providerId?: string) => {
      applySelection(id, id ? (providerId ?? activeId) : undefined);
    },
    [activeId, applySelection]
  );

  const connected = useConnectedProviders();
  const connectedRef = useRef(connected);
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  /**
   * Applies `nextSelection`'s decision. A no-op (`"keep"`) is the common
   * case: once a model is selected, its owning provider stays connected,
   * and switching *away* from that provider without disconnecting it — the
   * ordinary case of looking at something else — must not disturb the
   * selection. `"set"` covers both nothing usable being selected yet (a
   * fresh session, or one that never had a provider connected) and the
   * owning provider having disconnected; either way the active provider is
   * moved to match, since a stale `activeId` would otherwise send the new
   * selection's model id to the old provider's API. `"clear"` is the same
   * disconnect with nothing left to fall back to.
   */
  useEffect(() => {
    const outcome = nextSelection({
      connected,
      currentModelId,
      owner: selectionRef.current.providerId,
    });

    if (outcome.kind === "set") {
      applySelection(outcome.modelId, outcome.providerId);
      if (activeId !== outcome.providerId) {
        setActiveId(outcome.providerId);
      }
    } else if (outcome.kind === "clear") {
      applySelection("", undefined);
    }
  }, [applySelection, connected, currentModelId, activeId, setActiveId]);

  const [input, setInput] = useState("");

  const initialMessages: ChatMessage[] = readChat(chatId)?.messages ?? [];

  /**
   * `useChat`'s own `setMessages`, mirrored so `onError` can reach it.
   *
   * `onError` is declared inside the options object below, which is evaluated
   * before `useChat` has returned anything — so the failure report has nothing
   * to append to unless the helper is threaded back in. A ref rather than a
   * `useState` because nothing renders from it, and it is written from an
   * effect rather than during render so a re-render can never publish a
   * setter belonging to a torn-down chat.
   *
   * There is no ordering hazard: an error can only follow a send, and a send
   * can only follow the mount that assigns this.
   */
  const setMessagesRef = useRef<
    UseChatHelpers<ChatMessage>["setMessages"] | undefined
  >(undefined);

  const {
    messages,
    setMessages,
    sendMessage,
    status,
    stop,
    regenerate,
    addToolApprovalResponse,
  } = useChat<ChatMessage>({
    generateId: generateUUID,
    id: chatId,
    messages: initialMessages,
    onData: (dataPart) => {
      if (dataPart.type === "data-waiting-status") {
        setWaitingStatus(dataPart.data);
        return;
      }
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));
    },
    /**
     * Every failed send arrives here, whichever way it failed.
     *
     * A transport that throws before a stream exists (no token, a refused
     * connection, a model that could not be built) reaches this directly. A
     * stream that carries an `{type: "error"}` chunk mid-flight reaches it too:
     * `Chat.makeRequest` hands `processUIMessageStream` an `onError` that
     * rethrows, so the chunk lands in the same `catch` as a thrown send. One
     * handler is therefore the whole of both paths, and one rendering
     * downstream reports them identically — which is right, because to a
     * reader they are the same event.
     *
     * The toast stays, as the thing that draws the eye at the moment it
     * happens; the message below it is the thing that is still there
     * afterwards, and after a reload.
     */
    onError: (error) => {
      toast({
        description:
          error instanceof ChatbotError
            ? error.message
            : describeSendFailure(error).detail,
        type: "error",
      });

      setMessagesRef.current?.((previous) => {
        const report = failureMessage({
          error,
          messages: previous,
          modelId: selectionRef.current.modelId,
          providerId: selectionRef.current.providerId ?? activeIdRef.current,
        });

        /*
         * The SDK opens an assistant message as soon as a send starts, so by
         * the time a failure arrives there is usually a bubble on screen
         * already holding nothing. Appending produced two replies to one
         * question — an empty one and the report. That empty bubble is the
         * carcass of the answer that never came, so the report takes its
         * place. Anything the model did manage to say before failing is left
         * alone, and the report follows it.
         */
        return isBlankReply(previous.at(-1))
          ? [...previous.slice(0, -1), report]
          : [...previous, report];
      });
    },
    sendAutomaticallyWhen: ({ messages: currentMessages }) => {
      const lastMessage = currentMessages.at(-1);
      return (
        lastMessage?.parts?.some(
          (part) =>
            "state" in part &&
            part.state === "approval-responded" &&
            "approval" in part &&
            (part.approval as { approved?: boolean })?.approved === true
        ) ?? false
      );
    },
    transport: new OAuthChatTransport(() =>
      resolveRequest({
        activeAccessToken: tokensRef.current?.accessToken,
        activeId: activeIdRef.current,
        connected: connectedRef.current,
        modelId: selectionRef.current.modelId,
        owner: selectionRef.current.providerId,
      })
    ),
  });

  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);

  useEffect(() => {
    if (status === "submitted" || status === "ready" || status === "error") {
      setWaitingStatus(undefined);
    }
  }, [status, setWaitingStatus]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (prevChatIdRef.current !== chatId) {
      prevChatIdRef.current = chatId;
      if (isNewChat) {
        setMessages([]);
      }
    }
  }, [chatId, isNewChat, setMessages]);

  const hasAppendedQueryRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("query");
    if (query && !hasAppendedQueryRef.current) {
      hasAppendedQueryRef.current = true;
      window.history.replaceState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      sendMessage({
        parts: [{ text: query, type: "text" }],
        role: "user" as const,
      });
    }
  }, [sendMessage, chatId]);

  usePersistChat({ chatId, messages, status });

  /**
   * Clearing needs no special handling from `usePersistChat`: it empties
   * the messages and deletes the store entry, and the next settled render
   * simply finds nothing stored for this `chatId` — so any new exchange,
   * whatever its eventual length, is seen as new content by construction.
   */
  const clearChat = useCallback(() => {
    setMessages(() => []);
    deleteChat(chatId);
  }, [chatId, setMessages]);

  const value = useMemo<ActiveChatContextValue>(
    () => ({
      addToolApprovalResponse,
      chatId,
      clearChat,
      currentModelId,
      input,
      isLoading: false,
      messages,
      regenerate,
      sendMessage,
      setCurrentModelId,
      setInput,
      setMessages,
      status,
      stop,
    }),
    [
      chatId,
      clearChat,
      messages,
      setMessages,
      sendMessage,
      status,
      stop,
      regenerate,
      addToolApprovalResponse,
      input,
      currentModelId,
      setCurrentModelId,
    ]
  );

  return (
    <ActiveChatContext.Provider value={value}>
      {children}
    </ActiveChatContext.Provider>
  );
}

export function useActiveChat() {
  const context = useContext(ActiveChatContext);
  if (!context) {
    throw new Error("useActiveChat must be used within ActiveChatProvider");
  }
  return context;
}
