/**
 * The sign-in popup, in the one shape this app opens it.
 *
 * These numbers are not chosen here. They are `popupReceiver`'s own defaults
 * — `packages/browser/src/popup.ts` in the SDK: 520 x 680, centred on the
 * opener through `window.screenX/screenY` and `outerWidth/outerHeight`, and
 * opened with `popup=yes` so the browser gives it a window rather than a tab.
 * OpenRouter's sign-in goes through that receiver and never touches this
 * module.
 *
 * This exists because the device flows have no receiver to borrow it from:
 * nothing redirects back to us, so the dialog opens the provider's
 * verification page itself and there is no `present()` call to do it. The
 * owner asked for those to open "just like what we do for openrouter", and
 * the only way that stays true is for both to be the same window — hence one
 * place, and a test (`auth-dialog.device-flow.test.tsx`) that asserts our
 * `window.open` call and the receiver's agree rather than that ours matches a
 * literal copied across once.
 *
 * The SDK does not export these, so they are mirrored rather than imported.
 * If it ever does, delete this and import them.
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
 * Opens `url` as a popup and hands back the handle, or `null` when there is
 * none to be had — a popup blocker, a runtime with no `open`.
 *
 * `noopener` is deliberately not passed, and it is the same trade the paste
 * flow's `openAuthorizationTab` documents: `noopener` is precisely what makes
 * `window.open` return `null` and makes the browser ignore the window name,
 * so there is no version of this that severs the opener and still lets the
 * caller focus or close the window it opened. What is opened is the
 * provider's own page, at a URL that provider supplied over TLS.
 *
 * `name` is per-provider and stable, so a second click reuses the window that
 * is already open instead of stacking another beside it.
 */
export function openPopup(url: string, name: string): Window | null {
  try {
    return window.open(url, name, popupFeatures());
  } catch {
    return null;
  }
}
