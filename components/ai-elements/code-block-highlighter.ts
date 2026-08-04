import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { createHighlighter } from "shiki";
import { BoundedMap } from "@/lib/bounded-map";

export type TokenizedCode = {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
};

/**
 * A long transcript renders hundreds of code blocks, and a tokenised block is
 * several times the size of its source — so this is bounded rather than kept
 * for the life of the tab.
 */
const TOKEN_CACHE_LIMIT = 120;

const tokensCache = new BoundedMap<string, TokenizedCode>(TOKEN_CACHE_LIMIT);

/** Bounded by the number of languages the app ever renders, so a plain Map. */
const highlighterCache = new Map<
  string,
  Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>
>();

const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

/** Keys of highlights already running, so a re-render does not start a second. */
const inFlight = new Set<string>();

const KEY_SAMPLE_LENGTH = 100;

function cacheKey(code: string, language: BundledLanguage): string {
  const start = code.slice(0, KEY_SAMPLE_LENGTH);
  const end =
    code.length > KEY_SAMPLE_LENGTH ? code.slice(-KEY_SAMPLE_LENGTH) : "";

  return `${language}:${code.length}:${start}:${end}`;
}

function getHighlighter(
  language: BundledLanguage
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  const cached = highlighterCache.get(language);

  if (cached) {
    return cached;
  }

  const created = createHighlighter({
    langs: [language],
    themes: ["github-light", "github-dark"],
  });

  highlighterCache.set(language, created);

  return created;
}

/** Shown immediately while the real highlight loads. */
export function createRawTokens(code: string): TokenizedCode {
  return {
    bg: "transparent",
    fg: "inherit",
    tokens: code
      .split("\n")
      .map((line) =>
        line === "" ? [] : [{ color: "inherit", content: line } as ThemedToken]
      ),
  };
}

function publish(key: string, result: TokenizedCode) {
  const listeners = subscribers.get(key);

  subscribers.delete(key);
  inFlight.delete(key);

  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener(result);
  }
}

function startHighlight(
  key: string,
  code: string,
  language: BundledLanguage
): void {
  if (inFlight.has(key)) {
    return;
  }

  inFlight.add(key);

  getHighlighter(language)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const available = highlighter.getLoadedLanguages();
      const result = highlighter.codeToTokens(code, {
        lang: available.includes(language) ? language : "text",
        themes: { dark: "github-dark", light: "github-light" },
      });

      const tokenized: TokenizedCode = {
        bg: result.bg ?? "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      tokensCache.set(key, tokenized);
      publish(key, tokenized);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .catch((error) => {
      console.error("Failed to highlight code:", error);
      subscribers.delete(key);
      inFlight.delete(key);
    });
}

/**
 * Returns the cached tokens if there are any, otherwise `null` and a background
 * highlight whose result reaches `callback`. Returns an unsubscribe so a block
 * that unmounts mid-highlight does not keep its component alive.
 *
 * Never on the server: this is called from a render body, and these caches are
 * module scope, shared by every reader in the lambda.
 */
export function highlightCode(
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void
): { tokens: TokenizedCode | null; unsubscribe: () => void } {
  const noop = () => undefined;

  if (typeof window === "undefined") {
    return { tokens: null, unsubscribe: noop };
  }

  const key = cacheKey(code, language);
  const cached = tokensCache.get(key);

  if (cached) {
    return { tokens: cached, unsubscribe: noop };
  }

  let unsubscribe = noop;

  if (callback) {
    const listeners = subscribers.get(key) ?? new Set();

    listeners.add(callback);
    subscribers.set(key, listeners);

    unsubscribe = () => {
      listeners.delete(callback);

      // Only if the map still holds *this* set: a later block under the same
      // key may already have registered its own after an eviction.
      if (listeners.size === 0 && subscribers.get(key) === listeners) {
        subscribers.delete(key);
      }
    };
  }

  startHighlight(key, code, language);

  return { tokens: null, unsubscribe };
}
