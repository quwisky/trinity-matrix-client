import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { Diagnostic } from '@codemirror/lint';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type {
  ConfigApplyPlan,
  ConfigJsonSchema,
  ConfigSchemaNode,
} from '@trinity/platform-native';

/**
 * What the editor knows about the document, and where in the text it applies.
 *
 * Everything here is driven by {@link ConfigJsonSchema} — which is generated from the live
 * `ConfigEntry` registry — and by the plan `AppConfigService` builds from that same registry.
 * Nothing about a setting is described twice: the completion list, the hover text and the
 * diagnostics are three views of the one place a setting declares itself, so the editor cannot
 * offer a value Apply would then refuse.
 *
 * Pure on purpose: every function here takes an `EditorState` and returns data. No `EditorView`,
 * no DOM, no injector — so the behaviour that actually matters (which values are offered where,
 * and which range a problem lands on) is testable without mounting an editor.
 */

/** Lezer's node names for the JSON grammar, spelled once. */
const NODE = {
  object: 'Object',
  property: 'Property',
  propertyName: 'PropertyName',
} as const;

/** Node names that stand for a whole JSON value, which is what a setting's value is. */
const VALUE_NODES = ['String', 'Number', 'True', 'False', 'Null', 'Object'];

/**
 * The value nodes a hover resolves on.
 *
 * `Object` is left out although it is a value: an object spans every line of its group, so
 * hovering anywhere inside `settings` would pop the envelope's own description over whatever
 * the pointer is actually on. The group's key still hovers, which is where someone points.
 */
const HOVERABLE_VALUES = ['String', 'Number', 'True', 'False', 'Null'];

/** Keeps the completion list open while a bare word or a dotted path is being typed. */
const CONTINUES_WORD = /^[\w.$-]*$/;

/** How far back a fresh cursor looks for the punctuation that says key or value. */
const MAX_LOOKBEHIND = 4096;

/** A place in the document a completion or a hover resolves to. */
interface TextRange {
  readonly from: number;
  readonly to: number;
}

/** What the schema says about one path, for the hover card. */
export interface ConfigHoverInfo extends TextRange {
  /** The dotted path as the document spells it, e.g. `settings.theme.palette`. */
  readonly path: string;
  readonly description: string;
  /** The JSON type(s), already prose: `string`, or `object or null`. */
  readonly type: string;
  /** The complete accepted set, when the setting is a closed choice. */
  readonly choices: readonly string[];
}

/**
 * Where the cursor is, in the document's own terms.
 *
 * `key` and `value` are the only two positions worth completing in a settings document, and
 * they want opposite things — the names a group offers, or the values one setting accepts.
 * `quoted` says whether the completion has to bring its own quotes, which is the difference
 * between typing inside `"…"` and typing into empty space after a `{` or a `:`.
 */
type CursorPlace =
  | {
      readonly kind: 'key';
      /** Path of the object being typed into: `['settings', 'theme']`. */
      readonly path: readonly string[];
      readonly range: TextRange;
      readonly quoted: boolean;
      /** Names already written in this object, so the list does not offer them twice. */
      readonly taken: ReadonlySet<string>;
    }
  | {
      readonly kind: 'value';
      /** Path of the setting whose value is being typed: `['settings','theme','palette']`. */
      readonly path: readonly string[];
      readonly range: TextRange;
      readonly quoted: boolean;
    };

/**
 * Completions for the document: the names a group offers at a key position, and the values a
 * setting accepts at a value position.
 *
 * The value half is the one that earns the feature: a palette or a date format is a closed set
 * the registry already declares, and picking from it is the difference between a document that
 * applies and one Apply refuses.
 */
export function configCompletionSource(
  schema: ConfigJsonSchema,
): (context: CompletionContext) => CompletionResult | null {
  return (context) => {
    const place = cursorPlace(context.state, context.pos);
    if (!place) {
      return null;
    }
    const options =
      place.kind === 'key'
        ? keyOptions(schema, place)
        : valueOptions(schema, place);
    if (options.length === 0) {
      return null;
    }
    return {
      from: place.range.from,
      to: place.range.to,
      options,
      validFor: CONTINUES_WORD,
    };
  };
}

/** What the schema says about the setting or group under `pos`, or null where it says nothing. */
export function configHoverInfo(
  schema: ConfigJsonSchema,
  state: EditorState,
  pos: number,
): ConfigHoverInfo | null {
  const node = syntaxTree(state).resolveInner(pos, 1);
  const named = namedNode(state, node);
  if (!named) {
    return null;
  }
  const described = schemaAt(schema, named.path);
  if (!described?.description) {
    return null;
  }
  return {
    from: named.range.from,
    to: named.range.to,
    path: named.path.join('.'),
    description: described.description,
    type: describeType(described),
    choices: described.enum ?? [],
  };
}

/**
 * The plan's problems and warnings, each on the range of the setting it is about.
 *
 * The plan is the authority on *what* is wrong — it comes from `AppConfigService.validateJson`,
 * so the editor's red underline and the Apply gate are the same check and can never disagree —
 * and the syntax tree is the authority on *where*. Matching the two by path is what keeps this
 * from being a second implementation of the rules.
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

/** The JSON type(s) of a node as prose: `string`, or `object or null`. */
function describeType(node: ConfigSchemaNode): string {
  if (!node.type) {
    return '';
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.length <= 1) {
    return types.join('');
  }
  return `${types.slice(0, -1).join(', ')} or ${types[types.length - 1]}`;
}

/** Walk the generated schema to the node one dotted path names, or null when it has none. */
function schemaAt(
  schema: ConfigJsonSchema,
  path: readonly string[],
): ConfigSchemaNode | null {
  let node: ConfigSchemaNode = schema;
  for (const segment of path) {
    const child = node.properties?.[segment];
    if (!child) {
      return null;
    }
    node = child;
  }
  return node;
}

function keyOptions(
  schema: ConfigJsonSchema,
  place: Extract<CursorPlace, { kind: 'key' }>,
): readonly Completion[] {
  const parent = schemaAt(schema, place.path);
  const properties = parent?.properties;
  if (!properties) {
    return [];
  }
  const options: Completion[] = [];
  for (const name of Object.keys(properties)) {
    if (place.taken.has(name)) {
      continue;
    }
    const child = properties[name];
    const group = !!child.properties;
    options.push({
      label: name,
      // A group is a container, a setting is a value: separate icons so the shape of the
      // document is readable from the list itself.
      type: group ? 'namespace' : 'property',
      detail: group ? groupDetail(child) : describeType(child),
      info: child.description,
      apply: place.quoted ? `"${name}": ` : name,
    });
  }
  return options;
}

function groupDetail(node: ConfigSchemaNode): string {
  const count = Object.keys(node.properties ?? {}).length;
  return count === 1 ? '1 setting' : `${count} settings`;
}

function valueOptions(
  schema: ConfigJsonSchema,
  place: Extract<CursorPlace, { kind: 'value' }>,
): readonly Completion[] {
  const setting = schemaAt(schema, place.path);
  if (!setting) {
    return [];
  }
  const options: Completion[] = [];
  for (const choice of setting.enum ?? []) {
    options.push({
      label: choice,
      type: 'enum',
      info: setting.description,
      apply: place.quoted ? `"${choice}"` : choice,
    });
  }
  if (options.length > 0) {
    // A closed choice is complete by definition: offering `true` beside it would be noise.
    return options;
  }
  const types = setting.type
    ? Array.isArray(setting.type)
      ? setting.type
      : [setting.type]
    : [];
  for (const literal of literalsFor(types)) {
    options.push({
      label: literal,
      type: 'keyword',
      info: setting.description,
    });
  }
  return options;
}

/** The JSON literals a type list allows — the only values worth offering without an enum. */
function literalsFor(types: readonly string[]): readonly string[] {
  const literals: string[] = [];
  if (types.indexOf('boolean') >= 0) {
    literals.push('false', 'true');
  }
  if (types.indexOf('null') >= 0) {
    literals.push('null');
  }
  return literals;
}

/**
 * Resolve the cursor to a key or a value position.
 *
 * Two shapes have to be told apart: sitting *inside* a string, where the range to replace is
 * the text between the quotes and the completion must not bring its own; and sitting in empty
 * space, where the last piece of punctuation is the only thing that says whether a name or a
 * value is expected — `{` and `,` open a key, `:` opens a value.
 */
function cursorPlace(state: EditorState, pos: number): CursorPlace | null {
  const node = syntaxTree(state).resolveInner(pos, -1);
  const inString = stringPlace(state, node);
  if (inString) {
    return inString;
  }

  const object = enclosingObject(node);
  if (!object) {
    return null;
  }
  const previous = lastMeaningfulChar(state, object.from, pos);
  if (previous === ':') {
    const property = propertyBefore(state, object, pos);
    return property
      ? {
          kind: 'value',
          path: objectPath(state, object).concat(property),
          range: { from: pos, to: pos },
          quoted: true,
        }
      : null;
  }
  if (previous === '{' || previous === ',') {
    return {
      kind: 'key',
      path: objectPath(state, object),
      range: { from: pos, to: pos },
      quoted: true,
      taken: takenNames(state, object),
    };
  }
  return null;
}

/** The key or value position for a cursor sitting inside a `"…"`, or null when it is not. */
function stringPlace(state: EditorState, node: SyntaxNode): CursorPlace | null {
  const isName = node.name === NODE.propertyName;
  if (!isName && node.name !== 'String') {
    return null;
  }
  const range = insideQuotes(state, node);
  const property = node.parent;
  if (!property || property.name !== NODE.property) {
    return null;
  }
  const object = property.parent;
  if (!object || object.name !== NODE.object) {
    return null;
  }
  if (isName) {
    return {
      kind: 'key',
      path: objectPath(state, object),
      range,
      quoted: false,
      taken: takenNames(state, object, property),
    };
  }
  const name = propertyName(state, property);
  return name === null
    ? null
    : {
        kind: 'value',
        path: objectPath(state, object).concat(name),
        range,
        quoted: false,
      };
}

/**
 * The text between a string's quotes.
 *
 * The closing quote is only dropped when it is actually there: half-typed `"ame` is the state
 * the editor spends most of its time in, and treating its last character as a quote would eat
 * a letter out of the range being completed.
 */
function insideQuotes(state: EditorState, node: SyntaxNode): TextRange {
  const text = state.sliceDoc(node.from, node.to);
  const from = text.charAt(0) === '"' ? node.from + 1 : node.from;
  const closed = text.length > 1 && text.charAt(text.length - 1) === '"';
  return { from, to: closed ? node.to - 1 : node.to };
}

/** The nearest `Object` at or above a node — the thing every path is measured from. */
function enclosingObject(node: SyntaxNode): SyntaxNode | null {
  for (
    let current: SyntaxNode | null = node;
    current;
    current = current.parent
  ) {
    if (current.name === NODE.object) {
      return current;
    }
  }
  return null;
}

/** The dotted path of an object itself, read off the properties it is nested inside. */
function objectPath(state: EditorState, object: SyntaxNode): string[] {
  const segments: string[] = [];
  for (
    let current: SyntaxNode | null = object.parent;
    current;
    current = current.parent
  ) {
    if (current.name !== NODE.property) {
      continue;
    }
    const name = propertyName(state, current);
    if (name === null) {
      // An unreadable ancestor makes everything below it a guess, and a guessed path would
      // offer the wrong settings with full confidence. Better to offer nothing.
      return [];
    }
    segments.push(name);
  }
  return segments.reverse();
}

/** A property's name with its quotes removed, or null when it has none to read. */
function propertyName(state: EditorState, property: SyntaxNode): string | null {
  const name = property.firstChild;
  if (!name || name.name !== NODE.propertyName) {
    return null;
  }
  const raw = state.sliceDoc(name.from, name.to);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    // Half-typed, so it names nothing yet.
    return null;
  }
}

/** The names an object already carries, so completion does not offer a duplicate key. */
function takenNames(
  state: EditorState,
  object: SyntaxNode,
  except?: SyntaxNode,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (let child = object.firstChild; child; child = child.nextSibling) {
    if (
      child.name !== NODE.property ||
      (except && child.from === except.from)
    ) {
      continue;
    }
    const name = propertyName(state, child);
    if (name !== null) {
      names.add(name);
    }
  }
  return names;
}

/** The name of the last property that starts before `pos` — whose value is being typed. */
function propertyBefore(
  state: EditorState,
  object: SyntaxNode,
  pos: number,
): string | null {
  let found: string | null = null;
  for (let child = object.firstChild; child; child = child.nextSibling) {
    if (child.name === NODE.property && child.from < pos) {
      found = propertyName(state, child) ?? found;
    }
  }
  return found;
}

/** The last non-whitespace character before `pos`, within one object's text. */
function lastMeaningfulChar(
  state: EditorState,
  start: number,
  pos: number,
): string | null {
  const from = Math.max(start, pos - MAX_LOOKBEHIND);
  const text = state.sliceDoc(from, pos);
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text.charAt(index);
    if (!/\s/.test(char)) {
      return char;
    }
  }
  return null;
}

/**
 * The setting or group a node names, for the hover card.
 *
 * Both halves of a property answer: the name, because that is what someone points at when they
 * are asking "what is this setting?", and the value, because that is what they point at when
 * they are asking "what else could this be?".
 */
function namedNode(
  state: EditorState,
  node: SyntaxNode,
): { readonly path: string[]; readonly range: TextRange } | null {
  const isName = node.name === NODE.propertyName;
  if (!isName && HOVERABLE_VALUES.indexOf(node.name) < 0) {
    return null;
  }
  const property = node.parent;
  if (!property || property.name !== NODE.property) {
    return null;
  }
  const object = property.parent;
  if (!object || object.name !== NODE.object) {
    return null;
  }
  const name = propertyName(state, property);
  if (name === null) {
    return null;
  }
  return {
    path: objectPath(state, object).concat(name),
    range: { from: node.from, to: node.to },
  };
}

/** Every path present in the document, and where its name and its value sit. */
interface SettingRange {
  readonly key: TextRange;
  readonly value: TextRange;
}

/**
 * Every path the *document* writes, keyed the way the plan names it.
 *
 * The plan's paths are relative to the settings block (`theme.palette`), so the walk drops that
 * one prefix and keeps everything else verbatim — including a path this build has never heard
 * of, which is exactly the one an "unknown setting" warning needs a range for.
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
 * A line names its path first (`theme.palette: 'mauve' is not …`, `theme.mauve is not a
 * setting …`), so the longest path the document actually writes that the line starts with is
 * the one it belongs to. A line about the document as a whole — a missing version, unreadable
 * JSON — has no path, and lands on the first line unless the parser has already underlined the
 * real spot, in which case saying it twice only buries the useful one.
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
