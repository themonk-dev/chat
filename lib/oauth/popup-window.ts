/**
 * Mirrors `popupReceiver`'s own defaults, so the device flows' verification
 * window matches OpenRouter's sign-in exactly. The SDK does not export them; if
 * it ever does, delete this and import them.
 */
const POPUP_HEIGHT = 680;
const POPUP_WIDTH = 520;

/** The `windowFeatures` string, centred on the window this is called from. */
export function popupFeatures(): string {
  const left =
    window.screenX + Math.max(0, (window.outerWidth - POPUP_WIDTH) / 2);
  const top =
    window.screenY + Math.max(0, (window.outerHeight - POPUP_HEIGHT) / 2);

  return `popup=yes,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${Math.round(left)},top=${Math.round(top)}`;
}

/**
 * `null` when there is no handle to be had. `noopener` is deliberately not
 * passed: it is what makes `window.open` return `null` and the browser ignore
 * the name, so the caller could no longer focus or close what it opened.
 */
export function openPopup(url: string, name: string): Window | null {
  try {
    return window.open(url, name, popupFeatures());
  } catch {
    return null;
  }
}
