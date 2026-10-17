import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type { ConfigApplyPlan } from '@trinity/platform-native';

import { NODE, propertyName, type TextRange } from './config-intellisense';

/** Node names that stand for a whole JSON value, which is what a setting's value is. */
const VALUE_NODES = ['String', 'Number', 'True', 'False', 'Null', 'Object'];

/**
 * The plan's problems and warnings, each on the range of the setting it is about.
 *
 * The plan (`AppConfigService.validateJson`) decides what is wrong, so the underline and the
 * Apply gate cannot disagree; the syntax tree decides where. Matching by path avoids a
 * second implementation of the rules.
 */
export function configDiagnostics(
  state: EditorState,
  plan: ConfigApplyPlan,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const syntaxErrors = syntaxDiagnostics(state);
  for (const diagnostic of syntaxErrors) {
    diagnostics.push(diagnostic);
  }

  const ranges = settingRanges(state);
  const problems = plan.ok ? [] : plan.problems;
  for (const problem of problems) {
    place(
      diagnostics,
      state,
      ranges,
      problem,
      'error',
      syntaxErrors.length > 0,
    );
  }
  for (const warning of plan.warnings) {
    place(
      diagnostics,
      state,
      ranges,
      warning,
      'warning',
      syntaxErrors.length > 0,
    );
  }
  return diagnostics.sort((left, right) => left.from - right.from);
}

/** Every path present in the document, and where its name and its value sit. */
interface SettingRange {
  readonly key: TextRange;
  readonly value: TextRange;
}

/**
 * Every path the *document* writes, keyed the way the plan names it.
 *
 * The plan's paths are relative to the settings block, so the walk drops that one prefix and
 * keeps the rest verbatim, including paths this build doesn't know (an "unknown setting"
 * warning needs a range for those).
 */
function settingRanges(state: EditorState): ReadonlyMap<string, SettingRange> {
  const ranges = new Map<string, SettingRange>();
  const root = syntaxTree(state).topNode.firstChild;
  if (!root || root.name !== NODE.object) {
    return ranges;
  }
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.name !== NODE.property) {
      continue;
    }
    const name = propertyName(state, child);
    if (name === null) {
      continue;
    }
    const value = child.lastChild;
    if (name === 'settings' && value && value.name === NODE.object) {
      collectRanges(state, value, '', ranges);
      continue;
    }
    record(state, child, name, ranges);
  }
  return ranges;
}

function collectRanges(
  state: EditorState,
  object: SyntaxNode,
  prefix: string,
  ranges: Map<string, SettingRange>,
): void {
  for (let child = object.firstChild; child; child = child.nextSibling) {
    if (child.name !== NODE.property) {
      continue;
    }
    const name = propertyName(state, child);
    if (name === null) {
      continue;
    }
    const path = prefix ? `${prefix}.${name}` : name;
    record(state, child, path, ranges);
    const value = child.lastChild;
    if (value && value.name === NODE.object) {
      collectRanges(state, value, path, ranges);
    }
  }
}

function record(
  state: EditorState,
  property: SyntaxNode,
  path: string,
  ranges: Map<string, SettingRange>,
): void {
  const key = property.firstChild;
  const value = property.lastChild;
  if (!key) {
    return;
  }
  const valueRange =
    value && value.from > key.to && VALUE_NODES.indexOf(value.name) >= 0
      ? { from: value.from, to: value.to }
      : { from: key.from, to: key.to };
  ranges.set(path, { key: { from: key.from, to: key.to }, value: valueRange });
}

/** Every place the parser gave up, so unreadable JSON is underlined where it broke. */
function syntaxDiagnostics(state: EditorState): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (!node.type.isError) {
        return;
      }
      diagnostics.push({
        from: node.from,
        to: Math.min(state.doc.length, Math.max(node.to, node.from + 1)),
        severity: 'error',
        message: "This isn't valid JSON here.",
      });
    },
  });
  return diagnostics;
}

/**
 * Put one of the plan's lines on the range it is about.
 *
 * A line starts with its path (`appearance.theme: 'mauve' is not …`), so the longest written
 * path it starts with owns it. A line with no path (missing version, unreadable JSON) lands
 * on the first line, unless the parser has already underlined the real spot.
 */
function place(
  diagnostics: Diagnostic[],
  state: EditorState,
  ranges: ReadonlyMap<string, SettingRange>,
  message: string,
  severity: 'error' | 'warning',
  hasSyntaxErrors: boolean,
): void {
  let match: {
    path: string;
    range: SettingRange;
    aboutValue: boolean;
  } | null = null;
  for (const [path, range] of ranges) {
    if (!message.startsWith(path)) {
      continue;
    }
    const next = message.charAt(path.length);
    if (next !== ':' && next !== ' ') {
      continue;
    }
    if (!match || path.length > match.path.length) {
      match = { path, range, aboutValue: next === ':' };
    }
  }

  if (match) {
    const target = match.aboutValue ? match.range.value : match.range.key;
    diagnostics.push({
      from: target.from,
      to: target.to,
      severity,
      message: message.slice(match.path.length).replace(/^:\s*/, ''),
    });
    return;
  }
  if (hasSyntaxErrors) {
    return;
  }
  diagnostics.push({
    from: 0,
    to: Math.min(state.doc.length, state.doc.lineAt(0).to),
    severity,
    message,
  });
}
