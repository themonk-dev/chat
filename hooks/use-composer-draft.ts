"use client";

import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";
import { useLocalStorage } from "usehooks-ts";

const AUTOFOCUS_DELAY_MS = 100;

/**
 * Restores a draft once, on mount, from storage alone — never from the DOM.
 * Preferring `textareaRef.current.value` inverted the direction the value
 * travels and made this effect and the save below into a loop that could revert
 * a composer the reader had already emptied.
 */
export function useComposerDraft(
  input: string,
  setInput: Dispatch<SetStateAction<string>>
) {
  const [storedDraft, setStoredDraft] = useLocalStorage("input", "");
  const restoredRef = useRef(false);

  useEffect(() => {
    if (restoredRef.current) {
      return;
    }

    restoredRef.current = true;

    if (storedDraft && !input) {
      setInput(storedDraft);
    }
  }, [input, storedDraft, setInput]);

  useEffect(() => {
    setStoredDraft(input);
  }, [input, setStoredDraft]);

  return setStoredDraft;
}

export function useAutoFocus(
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
  width: number | undefined
) {
  const focusedRef = useRef(false);

  useEffect(() => {
    if (focusedRef.current || !width) {
      return;
    }

    const timer = setTimeout(() => {
      textareaRef.current?.focus();
      focusedRef.current = true;
    }, AUTOFOCUS_DELAY_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [textareaRef, width]);
}
