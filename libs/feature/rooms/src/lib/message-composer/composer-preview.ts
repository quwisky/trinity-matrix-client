import {
  escapeHtml,
  linkifyMessageText,
  renderMarkdown,
  replyTextArt,
  sanitizeMatrixHtml,
  slashCommandContent,
  textMessageContent,
  type Mention,
  type SlashCommandContext,
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
 * `context` is which leading slash commands are read on the way out. Ordinary Conversation and
 * exact-thread sends read them all; a reply applies only the text art (`replyTextArt`); an
 * edit and an attachment caption read none. Previewing `/spoiler x` concealed while replying
 * would promise a spoiler and send the literal text.
 */
export function composerPreview(
  rawText: string,
  mentions: Mention[],
  context: SlashCommandContext,
): { html: string; rich: boolean } {
  const text = rawText.trim();
  if (!text) {
    return { html: '', rich: false };
  }
  const art = context === 'reply' ? replyTextArt(text, renderMarkdown) : null;
  const content = ((context === 'message'
    ? slashCommandContent(text, renderMarkdown, mentions)
    : null) ??
    textMessageContent(
      art?.text ?? text,
      art?.md ?? renderMarkdown(text),
      mentions,
    )) as {
    formatted_body?: string;
    body?: string;
  };
  const html = content.formatted_body;
  if (html) {
    // The names the composer inserted, so the preview's pills read as typed.
    const names = Object.fromEntries(
      mentions.map((m) => [m.userId, m.display.replace(/^@/, '')]),
    );
    return { html: sanitizeMatrixHtml(html, null, names), rich: true };
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
