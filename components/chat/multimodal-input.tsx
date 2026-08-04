"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import equal from "fast-deep-equal";
import { ArrowUpIcon, ExternalLinkIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  type ChangeEvent,
  type Dispatch,
  memo,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useLocalStorage, useWindowSize } from "usehooks-ts";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import {
  type ConnectedProviders,
  getSelectionProviderId,
  resolveRequest,
  useConnectedProviders,
} from "@/hooks/use-active-chat";
import { useProviderAuth } from "@/hooks/use-provider-auth";
import { deleteChat, listChats } from "@/lib/chats/store";
import { fetchModelsFor, type Model, modelsFor } from "@/lib/oauth/models";
import { PROVIDER_ORDER, registry } from "@/lib/oauth/registry";
import type { Attachment, ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../ai-elements/prompt-input";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { StopIcon } from "./icons";
import { providerLogos } from "./provider-logos";
import {
  type SlashCommand,
  SlashCommandMenu,
  slashCommands,
} from "./slash-commands";
import { SuggestedActions } from "./suggested-actions";

function setCookie(name: string, value: string) {
  const maxAge = 60 * 60 * 24 * 365;
  // biome-ignore lint/suspicious/noDocumentCookie: needed for client-side cookie setting
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}`;
}

function PureMultimodalInput({
  chatId,
  clearChat,
  input,
  setInput,
  status,
  stop,
  attachments,
  setAttachments,
  messages,
  setMessages,
  sendMessage,
  className,
  selectedModelId,
  onModelChange,
  editingMessage,
  onCancelEdit,
  isLoading,
}: {
  chatId: string;
  clearChat: () => void;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  status: UseChatHelpers<ChatMessage>["status"];
  stop: () => void;
  attachments: Attachment[];
  setAttachments: Dispatch<SetStateAction<Attachment[]>>;
  messages: UIMessage[];
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
  sendMessage:
    | UseChatHelpers<ChatMessage>["sendMessage"]
    | (() => Promise<void>);
  className?: string;
  selectedModelId: string;
  onModelChange?: (modelId: string, providerId: string) => void;
  editingMessage?: ChatMessage | null;
  onCancelEdit?: () => void;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const { activeId, tokens } = useProviderAuth();
  const connected = useConnectedProviders();

  /**
   * Whether this send can actually go out — asked of `resolveRequest`, the
   * same function the transport consults, rather than answered a second time
   * here.
   *
   * The question is *not* "is the active provider connected". A request is
   * addressed to the model's owner, and owner and active provider are
   * deliberately allowed to diverge: `nextSelection` answers `"keep"`
   * whenever the owner still holds a token, precisely so that connecting or
   * merely looking at another provider does not disturb a live selection. So
   * a reader can have a Claude model selected while `activeId` is `xai`,
   * disconnect Grok, and watch `useProviderAuth`'s `isConnected` go false for
   * a send that `resolveRequest` would still resolve perfectly — a button
   * greyed out for good, under a tooltip naming a provider they already have
   * connected.
   *
   * Calling the resolver is what keeps that from coming back. A second
   * derivation here — "does `owner` appear in `connected`" — would be correct
   * today and free to drift tomorrow; there is only one derivation, and both
   * the gate and the send read it.
   */
  const owner = getSelectionProviderId();
  const request = resolveRequest({
    activeAccessToken: tokens?.accessToken,
    activeId,
    connected,
    modelId: selectedModelId,
    owner,
  });
  const canSend = Boolean(request.accessToken && request.modelId);

  /**
   * Named rather than generic whenever there is an owner to name: the state
   * this most often describes is one connected provider short, not none at
   * all, and "connect a provider" sends the reader to a popover that already
   * says "2 connected". With nothing selected there is no owner yet and no
   * particular provider to point at, so the generic wording is the honest one.
   */
  const sendHint = owner
    ? `Connect ${registry[owner]?.label ?? owner} to send a message`
    : "Connect a provider to send a message";

  const { setTheme, resolvedTheme } = useTheme();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { width } = useWindowSize();
  const hasAutoFocused = useRef(false);
  useEffect(() => {
    if (!hasAutoFocused.current && width) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
        hasAutoFocused.current = true;
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [width]);

  const [localStorageInput, setLocalStorageInput] = useLocalStorage(
    "input",
    ""
  );

  useEffect(() => {
    if (textareaRef.current) {
      const domValue = textareaRef.current.value;
      const finalValue = domValue || localStorageInput || "";
      setInput(finalValue);
    }
  }, [localStorageInput, setInput]);

  useEffect(() => {
    setLocalStorageInput(input);
  }, [input, setLocalStorageInput]);

  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);

  const handleInput = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const val = event.target.value;
      setInput(val);

      if (val.startsWith("/") && !val.includes(" ")) {
        setSlashOpen(true);
        setSlashQuery(val.slice(1));
        setSlashIndex(0);
      } else {
        setSlashOpen(false);
      }
    },
    [setInput]
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      setSlashOpen(false);
      setInput("");
      switch (cmd.action) {
        case "new":
          router.push("/");
          break;
        case "clear":
          clearChat();
          break;
        case "rename":
          toast("Rename is available from the sidebar chat menu.");
          break;
        case "model": {
          const modelBtn = document.querySelector<HTMLButtonElement>(
            "[data-testid='model-selector']"
          );
          modelBtn?.click();
          break;
        }
        case "theme":
          setTheme(resolvedTheme === "dark" ? "light" : "dark");
          break;
        case "delete":
          toast("Delete this chat?", {
            action: {
              label: "Delete",
              onClick: () => {
                deleteChat(chatId);
                router.push("/");
                toast.success("Chat deleted");
              },
            },
          });
          break;
        case "purge":
          toast("Delete all chats?", {
            action: {
              label: "Delete all",
              onClick: () => {
                for (const chat of listChats()) {
                  deleteChat(chat.id);
                }
                router.push("/");
                toast.success("All chats deleted");
              },
            },
          });
          break;
        default:
          break;
      }
    },
    [chatId, clearChat, resolvedTheme, router, setInput, setTheme]
  );

  const submitForm = useCallback(() => {
    window.history.pushState(
      {},
      "",
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
    );

    sendMessage({
      parts: [
        ...attachments.map((attachment) => ({
          mediaType: attachment.contentType,
          name: attachment.name,
          type: "file" as const,
          url: attachment.url,
        })),
        {
          text: input,
          type: "text",
        },
      ],
      role: "user",
    });

    setAttachments([]);
    setLocalStorageInput("");
    setInput("");

    if (width && width > 768) {
      textareaRef.current?.focus();
    }
  }, [
    input,
    setInput,
    attachments,
    sendMessage,
    setAttachments,
    setLocalStorageInput,
    width,
    chatId,
  ]);

  const handleCancelEditMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      onCancelEdit?.();
    },
    [onCancelEdit]
  );

  const handleSlashClose = useCallback(() => {
    setSlashOpen(false);
  }, []);

  const handlePromptSubmit = useCallback(() => {
    if (input.startsWith("/")) {
      const query = input.slice(1).trim();
      const cmd = slashCommands.find((c) => c.name === query);
      if (cmd) {
        handleSlashSelect(cmd);
      }
      return;
    }
    if (!input.trim() && attachments.length === 0) {
      return;
    }
    if (status === "ready" || status === "error") {
      submitForm();
    } else {
      toast.error("Please wait for the model to finish its response!");
    }
  }, [attachments.length, handleSlashSelect, input, status, submitForm]);

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (slashOpen) {
        const filtered = slashCommands.filter((cmd) =>
          cmd.name.startsWith(slashQuery.toLowerCase())
        );
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (filtered[slashIndex]) {
            handleSlashSelect(filtered[slashIndex]);
          }
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
      }
      if (e.key === "Escape" && editingMessage && onCancelEdit) {
        e.preventDefault();
        onCancelEdit();
      }
    },
    [
      editingMessage,
      handleSlashSelect,
      onCancelEdit,
      slashIndex,
      slashOpen,
      slashQuery,
    ]
  );

  return (
    <div className={cn("relative flex w-full flex-col gap-4", className)}>
      {editingMessage && onCancelEdit ? (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>Editing message</span>
          <button
            className="rounded px-1.5 py-0.5 text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
            onMouseDown={handleCancelEditMouseDown}
            type="button"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {!editingMessage &&
        !isLoading &&
        messages.length === 0 &&
        attachments.length === 0 && (
          <SuggestedActions chatId={chatId} sendMessage={sendMessage} />
        )}

      <div className="relative">
        {slashOpen ? (
          <SlashCommandMenu
            onClose={handleSlashClose}
            onSelect={handleSlashSelect}
            query={slashQuery}
            selectedIndex={slashIndex}
          />
        ) : null}
      </div>

      <PromptInput
        className="[&>div]:rounded-2xl [&>div]:border [&>div]:border-border/30 [&>div]:bg-card/70 [&>div]:shadow-[var(--shadow-composer)] [&>div]:transition-shadow [&>div]:duration-300 [&>div]:focus-within:shadow-[var(--shadow-composer-focus)]"
        onSubmit={handlePromptSubmit}
      >
        <PromptInputTextarea
          className="min-h-24 text-[13px] leading-relaxed px-4 pt-3.5 pb-1.5 placeholder:text-muted-foreground/35"
          data-testid="multimodal-input"
          onChange={handleInput}
          onKeyDown={handleTextareaKeyDown}
          placeholder={
            editingMessage ? "Edit your message..." : "Ask anything..."
          }
          ref={textareaRef}
          value={input}
        />
        <PromptInputFooter className="px-3 pb-3">
          <PromptInputTools>
            <ModelSelectorCompact
              connected={connected}
              onModelChange={onModelChange}
              selectedModelId={selectedModelId}
            />
          </PromptInputTools>

          {status === "submitted" ? (
            <StopButton setMessages={setMessages} stop={stop} />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex" data-testid="send-hint-trigger">
                  <PromptInputSubmit
                    className={cn(
                      "h-7 w-7 rounded-xl transition-all duration-200",
                      input.trim() && canSend
                        ? "bg-foreground text-background hover:opacity-85 active:scale-95"
                        : "bg-muted text-muted-foreground/25 cursor-not-allowed"
                    )}
                    data-testid="send-button"
                    disabled={!(input.trim() && canSend)}
                    status={status}
                    variant="secondary"
                  >
                    <ArrowUpIcon className="size-4" />
                  </PromptInputSubmit>
                </span>
              </TooltipTrigger>
              {canSend ? null : (
                <TooltipContent side="top">{sendHint}</TooltipContent>
              )}
            </Tooltip>
          )}
        </PromptInputFooter>
      </PromptInput>

      <ComposerAttribution />
    </div>
  );
}

/**
 * Quiet credit line under the composer for the two projects this app is
 * built on. Sits inside the same sticky footer as the input, so it can never
 * scroll over the conversation above it, and wraps at narrow widths instead
 * of forcing extra height onto the composer on mobile.
 */
function ComposerAttribution() {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-2 text-center text-[11px] text-muted-foreground/60">
      <span className="inline-flex items-center gap-1">
        OAuth by
        <a
          className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-foreground/50"
          href="https://ai-oauth.themonk.dev"
          rel="noopener noreferrer"
          target="_blank"
        >
          ai-oauth-sdk
          <ExternalLinkIcon className="size-3" />
        </a>
      </span>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        Chat interface based on
        <a
          className="inline-flex items-center gap-0.5 underline decoration-muted-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-foreground/50"
          href="https://vercel.com/templates/next.js/chatbot"
          rel="noopener noreferrer"
          target="_blank"
        >
          Vercel's Next.js AI Chatbot template
          <ExternalLinkIcon className="size-3" />
        </a>
      </span>
    </p>
  );
}

export const MultimodalInput = memo(
  PureMultimodalInput,
  (prevProps, nextProps) => {
    if (prevProps.input !== nextProps.input) {
      return false;
    }
    if (prevProps.status !== nextProps.status) {
      return false;
    }
    if (!equal(prevProps.attachments, nextProps.attachments)) {
      return false;
    }
    if (prevProps.selectedModelId !== nextProps.selectedModelId) {
      return false;
    }
    if (prevProps.editingMessage !== nextProps.editingMessage) {
      return false;
    }
    if (prevProps.isLoading !== nextProps.isLoading) {
      return false;
    }
    if (prevProps.messages.length !== nextProps.messages.length) {
      return false;
    }

    return true;
  }
);

/**
 * cmdk filters and tracks selection by this string, so it has to be unique
 * per row (providers can and do resell the same model under the same
 * display name — see `ProviderMark` below) while still containing the text a
 * reader would actually type to search.
 */
function itemValue(providerId: string, model: Model): string {
  return `${model.name} ${registry[providerId].label} ${providerId}:${model.id}`;
}

/**
 * The provider mark shown on every row, not just the group heading: two
 * connected providers can resell the same underlying model under the same
 * display name (GitHub Copilot and OpenRouter both carry "Claude Sonnet
 * 4.5"), and cmdk's search collapses the grouping that would otherwise
 * disambiguate them. `providerLogos`' SVGs are `aria-hidden` by design — they
 * are normally read beside a visible text label — but a row's mark can be
 * the only provider signal left once the list is filtered, so it gets its
 * own accessible name via a wrapping `role="img"` rather than inheriting the
 * hidden state from the SVG it wraps.
 */
function ProviderMark({
  className,
  providerId,
}: {
  className?: string;
  providerId: string;
}) {
  const Logo = providerLogos[providerId];

  if (!Logo) {
    return null;
  }

  return (
    <span
      aria-label={`${registry[providerId].label} logo`}
      className="inline-flex shrink-0 items-center"
      role="img"
    >
      <Logo className={className ?? "size-4"} />
    </span>
  );
}

function ModelSelectorOption({
  model,
  onSelect,
  providerId,
  selected,
}: {
  model: Model;
  onSelect: (providerId: string, model: Model) => void;
  providerId: string;
  selected: boolean;
}) {
  const handleSelect = useCallback(() => {
    onSelect(providerId, model);
  }, [model, onSelect, providerId]);

  return (
    <ModelSelectorItem
      className={cn(
        // Every row carries the border so only its colour changes when the
        // choice moves. Drawing it on the chosen row alone would add a pixel to
        // each side and nudge the whole list.
        "flex w-full items-center gap-2 border border-transparent transition-colors",
        // `data-[selected]` is cmdk's keyboard cursor, which is not the same
        // thing as the chosen model — hence the second, separate signal.
        "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
        selected && "border-dashed border-foreground/50"
      )}
      onSelect={handleSelect}
      value={itemValue(providerId, model)}
    >
      <ProviderMark providerId={providerId} />
      <ModelSelectorName>{model.name}</ModelSelectorName>
    </ModelSelectorItem>
  );
}

/** One connected provider's models, in the order they should be grouped. */
type ModelGroup = { providerId: string; models: Model[] };

/**
 * Takes the connection map rather than calling `useConnectedProviders()` for
 * itself: the composer above already holds one for its send gate, and two
 * instances in the same subtree means two full storage sweeps on mount and on
 * every revocation, describing the same fact. Sharing the one map also means
 * the picker and the gate cannot disagree about who is connected.
 */
function useModelGroups(connected: ConnectedProviders): {
  groups: ModelGroup[];
} {
  const [fetched, setFetched] = useState<Record<string, Model[]>>({});

  useEffect(() => {
    let cancelled = false;
    const entries = [...connected.entries()];

    Promise.all(
      entries.map(
        async ([id, token]) => [id, await fetchModelsFor(id, token)] as const
      )
    ).then((results) => {
      if (!cancelled) {
        setFetched(Object.fromEntries(results));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connected]);

  const groups = PROVIDER_ORDER.filter((id) => connected.has(id)).map((id) => ({
    models: fetched[id] ?? modelsFor(id),
    providerId: id,
  }));

  return { groups };
}

function PureModelSelectorCompact({
  connected,
  selectedModelId,
  onModelChange,
}: {
  connected: ConnectedProviders;
  selectedModelId: string;
  onModelChange?: (modelId: string, providerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { setActiveId } = useProviderAuth();
  const { groups } = useModelGroups(connected);

  /**
   * `getSelectionProviderId()` (from `hooks/use-active-chat.tsx`) is the
   * authoritative answer: it is written in lockstep with `currentModelId`
   * — the same `setCurrentModelId` call this component's own `onModelChange`
   * triggers, and the same recovery effect that moves `currentModelId` on
   * its own (connecting the first provider, recovering after the owning
   * provider disconnects). A component-local ref here previously stood in
   * for that answer, but `MultimodalInput` remounts on `/` <-> `/chat/[id]`
   * navigation while the chat context above it does not, so the ref lost
   * the association on every such navigation even though the selection
   * itself was still live. Reading the module-level mirror instead survives
   * exactly as long as `currentModelId` does, without adding a 15th member
   * to the frozen context contract.
   */
  const selectedProviderId = getSelectionProviderId();

  const selectedModel = selectedProviderId
    ? (
        groups.find((group) => group.providerId === selectedProviderId)
          ?.models ?? []
      ).find((model) => model.id === selectedModelId)
    : undefined;

  const handleSelect = useCallback(
    (providerId: string, model: Model) => {
      setActiveId(providerId);
      onModelChange?.(model.id, providerId);
      setCookie("chat-model", model.id);
      setOpen(false);
      setTimeout(() => {
        document
          .querySelector<HTMLTextAreaElement>(
            "[data-testid='multimodal-input']"
          )
          ?.focus();
      }, 50);
    },
    [onModelChange, setActiveId]
  );

  return (
    <ModelSelector onOpenChange={setOpen} open={open}>
      <ModelSelectorTrigger asChild>
        <Button
          className="h-7 max-w-[200px] justify-between gap-1.5 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          data-testid="model-selector"
          variant="ghost"
        >
          {selectedProviderId ? (
            <ProviderMark providerId={selectedProviderId} />
          ) : null}
          <ModelSelectorName>
            {selectedModel?.name ?? "Select a model"}
          </ModelSelectorName>
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent
        commandDefaultValue={
          selectedProviderId && selectedModel
            ? itemValue(selectedProviderId, selectedModel)
            : undefined
        }
      >
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          {groups.length === 0 ? (
            <ModelSelectorEmpty>
              Connect a provider to see its models.
            </ModelSelectorEmpty>
          ) : (
            groups.map(({ providerId, models }) => (
              <ModelSelectorGroup
                heading={registry[providerId].label}
                key={providerId}
              >
                {models.map((model) => (
                  <ModelSelectorOption
                    key={`${providerId}:${model.id}`}
                    model={model}
                    onSelect={handleSelect}
                    providerId={providerId}
                    selected={
                      providerId === selectedProviderId &&
                      model.id === selectedModelId
                    }
                  />
                ))}
              </ModelSelectorGroup>
            ))
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const ModelSelectorCompact = memo(PureModelSelectorCompact);

function PureStopButton({
  stop,
  setMessages,
}: {
  stop: () => void;
  setMessages: UseChatHelpers<ChatMessage>["setMessages"];
}) {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      stop();
      setMessages((messages) => messages);
    },
    [setMessages, stop]
  );

  return (
    <Button
      className="h-7 w-7 rounded-xl bg-foreground p-1 text-background transition-all duration-200 hover:opacity-85 active:scale-95 disabled:bg-muted disabled:text-muted-foreground/25 disabled:cursor-not-allowed"
      data-testid="stop-button"
      onClick={handleClick}
    >
      <StopIcon size={14} />
    </Button>
  );
}

const StopButton = memo(PureStopButton);
