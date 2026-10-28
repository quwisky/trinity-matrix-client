/**
 * One version of a message for the edit-history view: the original, or one `m.replace`
 * applied to it. Kept out of {@link MessageView} because history is fetched on demand and
 * would churn every row's identity.
 */
export interface MessageRevisionView {
  /** The event this version came from (the original event for the first entry). */
  id: string;
  /** When this version was sent (`origin_server_ts`). */
  timestamp: number;
  /** Plain-text body; also what a reader gets when `html` is null. */
  body: string;
  /** Sanitized HTML for the body, or null to render `body` as plain text. */
  html: string | null;
  /** `undecryptable` when we hold no key for this version — `body` is the standing notice. */
  kind: 'text' | 'undecryptable';
  /** Whether the current user sent this version — only they may remove it. */
  isOwn: boolean;
}
