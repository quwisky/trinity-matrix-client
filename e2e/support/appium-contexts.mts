/** One context as Appium details it (`getContexts({ returnDetailedContexts: true })`). */
export interface AppiumContext {
  readonly id: string;
  readonly url?: string;
  readonly bundleId?: string;
}

/**
 * The WebView context that shows the app's own page, chosen from its details alone.
 *
 * Switching into a context to read its URL is what the details spare: once a spec has opened
 * Safari (or an `SFSafariViewController` sheet), Safari's pages are `WEBVIEW_*` contexts too,
 * and switching into one can hang the session for the next spec (#1347). A context owned by
 * another app is skipped by its `bundleId`; one with no `bundleId` is judged by its URL alone.
 */
export function pickAppWebview(
  contexts: readonly AppiumContext[],
  app: { readonly origin: string; readonly bundleId: string },
): AppiumContext | null {
  return (
    contexts.find(
      (context) =>
        context.id.startsWith('WEBVIEW_') &&
        (context.bundleId === undefined || context.bundleId === app.bundleId) &&
        (context.url ?? '').startsWith(app.origin),
    ) ?? null
  );
}
