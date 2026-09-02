/** Strip block and line comments before a source guard searches authored rules. */
export const stripSourceComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/.*$/gmu, '$1');

/** Strip HTML comments before a source guard searches document-owned styles. */
export const stripMarkupComments = (source) =>
  source.replace(/<!--[\s\S]*?-->/gu, '');

/** Return the balanced block opened at `openingBrace`, including its closing offset. */
export function sourceStyleBlockAt(source, openingBrace) {
  if (source[openingBrace] !== '{') {
    throw new Error(`Expected an opening brace at offset ${openingBrace}`);
  }

  let depth = 1;
  let quote = null;
  let escaped = false;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    if (depth === 0) {
      return {
        body: source.slice(openingBrace + 1, index),
        end: index,
      };
    }
  }

  throw new Error(`Unbalanced style block at offset ${openingBrace}`);
}

function topLevelStyleEntries(source) {
  const css = stripSourceComments(source);
  const entries = [];
  let start = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '{') {
      const block = sourceStyleBlockAt(css, index);
      entries.push({
        type: 'block',
        prelude: css.slice(start, index).trim(),
        body: block.body,
      });
      index = block.end;
      start = block.end + 1;
    } else if (character === ';') {
      const statement = css.slice(start, index).trim();
      if (statement) entries.push({ type: 'statement', statement });
      start = index + 1;
    }
  }

  return entries;
}

/** Return outer rule blocks; nested rules stay inside their owning block body. */
export const topLevelStyleBlocks = (source) =>
  topLevelStyleEntries(source)
    .filter(({ type }) => type === 'block')
    .map(({ prelude, body }) => ({ prelude, body }));

/** Return semicolon-terminated statements outside any rule block. */
export const topLevelStyleStatements = (source) =>
  topLevelStyleEntries(source)
    .filter(({ type }) => type === 'statement')
    .map(({ statement }) => statement);
