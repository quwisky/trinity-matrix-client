/**
 * Getting a settings document from outside the app into the editor.
 *
 * Both routes are here rather than in the component because both are DOM plumbing with one
 * job — hand back text, or nothing — and because the clipboard route is the *primary* one on
 * mobile, where there is no file picker worth using and no automated harness in this repo
 * covers it. Keeping it a few lines apart from the component means it can be read on its own.
 *
 * Neither route parses or validates: what they return goes into the editor and through the
 * same check a hand edit does, so an imported document is never applied on a path a typed one
 * could not reach.
 */
import { catchError, defer, from, of, type Observable } from 'rxjs';

/** Said when the clipboard cannot be read — silence is indistinguishable from a dead button. */
export const CLIPBOARD_UNREADABLE_MESSAGE =
  'Could not read your clipboard. Paste the document into the box instead.';

/**
 * The text of the picked file, or null when the picker was dismissed.
 *
 * Clears the input's value first so picking the *same* file twice still fires a change event
 * — otherwise a failed import cannot be retried without choosing a different file.
 */
export function readPickedConfigFile$(event: Event): Observable<string | null> {
  return defer(() => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    return file ? from(file.text()) : of(null);
  });
}

/**
 * The clipboard's text, or null when it cannot be read.
 *
 * Null covers both a browser without the read half of the clipboard API and a user who
 * refused the permission prompt: from here they are the same event, and the caller says the
 * same thing either way.
 */
export function readClipboardConfig$(): Observable<string | null> {
  return defer(() => {
    const readText = navigator.clipboard?.readText.bind(navigator.clipboard);
    return readText ? from(readText()) : of(null);
  }).pipe(catchError(() => of(null)));
}
