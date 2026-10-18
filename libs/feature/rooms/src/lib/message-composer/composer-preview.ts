import {
  escapeHtml,
  linkifyMessageText,
  renderMarkdown,
  sanitizeMatrixHtml,
  slashCommandContent,
  textMessageContent,
  type Mention,
} from '@trinity/util/matrix';

/**
 * The message as it will arrive, rendered through the timeline's own path so the two cannot
 * disagree. Slash commands are previewed wherever the send path parses them (`/spoiler x`
 * sends a concealed span); where it does not (reply, edit, caption) the preview shows the
 * text as typed.
 *
 * `sanitizeMatrixHtml` adds the render-only normalisation the send path deliberately omits:
 * the spoiler class the reveal directive needs, the code-block language caption and syntax
 * highlighting.
 *
 * `parsesCommands` is whether a leading slash is read as a command on the way out. Only
 * ordinary Conversation and exact-thread sends are: a reply, an edit and an attachment
 * caption route through `replyMessageContent` / `editMessageContent` / `mediaCaptionFields`,
 * none of which look at a leading slash, so previewing `/spoiler x` concealed while replying
 * would promise a spoiler and send the literal text.
 */
export function composerPreview(
  rawText: string,
  mentions: Mention[],
  parsesCommands: boolean,
): { html: string; rich: boolean } {
  const text = rawText.trim();
  if (!text) {
    return { html: '', rich: false };
  }
  const content = ((parsesCommands
    ? slashCommandContent(text, renderMarkdown, mentions)
    : null) ?? textMessageContent(text, renderMarkdown(text), mentions)) as {
    formatted_body?: string;
    body?: string;
  };
  const html = content.formatted_body;
  if (html) {
    // The names the composer inserted, so the preview's pills read as typed.
    const names = Object.fromEntries(
      mentions.map((m) => [m.userId, m.display.replace(/^@/, '')]),
    );
    return { html: sanitizeMatrixHtml(html, false, names), rich: true };
  }
  // No formatted_body means plain text, which the timeline linkifies (raw body when there is
  // no URL); mirror both, including the container and link behaviour (an external link opens in
  // a new tab with no opener). `linkifyText` replaces newlines with `<br>`, so its output belongs
  // in the timeline's rendered-markdown container; without that class the link would render
  // browser-blue instead of in the Theme. The fallback keeps raw newlines and so needs
  // `pre-wrap`, which `rich: false` selects: hence `escapeHtml` and NOT `escapeInlineText`,
  // whose `<br>`s would double every line break.
  const body = content.body ?? text;
  const linkified = linkifyMessageText(body);
  return linkified !== null
    ? { html: linkified, rich: true }
    : { html: escapeHtml(body), rich: false };
}
