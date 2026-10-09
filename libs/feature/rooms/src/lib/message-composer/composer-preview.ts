import {
  escapeHtml,
  linkifyText,
  renderMarkdown,
  sanitizeMatrixHtml,
  slashCommandContent,
  textMessageContent,
  type Mention,
} from '@trinity/util/matrix';

/**
 * The message as it will arrive, rendered through the timeline's own path so the two cannot
 * disagree — including the slash commands wherever the send path parses them, because
 * `/spoiler x` sends a concealed span and previewing the literal text would be a lie in
 * exactly the case a preview is most useful. Where it does not parse them (reply, edit,
 * caption) the lie runs the other way, so the preview shows the text as typed.
 *
 * `sanitizeMatrixHtml` is what adds the render-only normalisation the send path deliberately
 * omits: the spoiler class the reveal directive needs, the code-block language caption and
 * syntax highlighting.
 *
 * `parsesCommands` is whether a leading slash is read as a command on the way out. Only
 * ordinary Conversation and exact-thread sends are: a reply, an edit and an attachment
 * caption route through `replyMessageContent` / `editMessageContent` / `mediaCaptionFields`,
 * none of which look at a leading slash — so previewing `/spoiler x` concealed while
 * replying would promise a spoiler and send the literal text.
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
    return { html: sanitizeMatrixHtml(html), rich: true };
  }
  // No formatted_body means it goes as plain text, which the timeline linkifies (falling
  // back to the raw body when there is no URL) — mirror both, including which container it
  // lands in. `linkifyText` replaces newlines with `<br>`, so its output belongs in the
  // rendered-markdown container the timeline uses at `message-row.component.html:88`;
  // without that class the link would render browser-blue instead of in the Theme.
  // The fallback keeps raw newlines and so needs `pre-wrap`, which is what `rich: false`
  // selects — hence `escapeHtml` and NOT `escapeInlineText`, whose `<br>`s would double
  // every line break under it.
  const body = content.body ?? text;
  const linkified = linkifyText(body);
  return linkified !== null
    ? { html: linkified, rich: true }
    : { html: escapeHtml(body), rich: false };
}
