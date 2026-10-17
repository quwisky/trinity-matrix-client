import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import type {
  ConfigJsonSchema,
  ConfigSchemaNode,
} from '@trinity/platform-native';

/**
 * Editor intelligence for the config document: completions, hover text and diagnostics.
 *
 * All three derive from {@link ConfigJsonSchema} (generated from the live `ConfigEntry`
 * registry) and the plan `AppConfigService` builds from it, so the editor cannot offer a
 * value Apply would refuse. Pure: functions take an `EditorState` and return data, so they
 * are testable without mounting an editor.
 */

/** Lezer's node names for the JSON grammar, spelled once. */
export const NODE = {
  object: 'Object',
  property: 'Property',
  propertyName: 'PropertyName',
} as const;

/**
 * The value nodes a hover resolves on. `Object` is left out: it spans every line of its
 * group, so hovering inside `settings` would show the envelope's description everywhere.
 */
const HOVERABLE_VALUES = ['String', 'Number', 'True', 'False', 'Null'];

/** Keeps the completion list open while a bare word or a dotted path is being typed. */
const CONTINUES_WORD = /^[\w.$-]*$/;

/** How far back a fresh cursor looks for the punctuation that says key or value. */
const MAX_LOOKBEHIND = 4096;

/** A place in the document a completion or a hover resolves to. */
export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/** What the schema says about one path, for the hover card. */
export interface ConfigHoverInfo extends TextRange {
  /** The dotted path as the document spells it, e.g. `settings.appearance.theme`. */
  readonly path: string;
  readonly description: string;
  /** The JSON type(s), already prose: `string`, or `object or null`. */
  readonly type: string;
  /** The complete accepted set, when the setting is a closed choice. */
  readonly choices: readonly string[];
}

/**
 * Where the cursor is: a `key` (names a group offers) or a `value` (values one setting
 * accepts). `quoted` says whether the completion must bring its own quotes (not inside `"…"`).
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
      /** Path of the setting whose value is being typed: `['appearance','theme']`. */
      readonly path: readonly string[];
      readonly range: TextRange;
      readonly quoted: boolean;
    };

/**
 * Completions: the names a group offers at a key position, and the values a setting accepts
 * at a value position (closed sets such as Theme come from the registry).
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
      // Separate icons for groups and settings, so the document's shape reads from the list.
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
 * Inside a string the range is the text between the quotes and the completion brings no
 * quotes of its own. In empty space the last punctuation decides: `{` and `,` open a key,
 * `:` opens a value.
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
 * The text between a string's quotes. The closing quote is dropped only when present:
 * half-typed `"ame` is the usual state, and treating its last character as a quote would eat
 * a letter.
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
      // An unreadable ancestor makes the path a guess, which would offer the wrong settings
      // with full confidence; offer nothing.
      return [];
    }
    segments.push(name);
  }
  return segments.reverse();
}

/** A property's name with its quotes removed, or null when it has none to read. */
export function propertyName(
  state: EditorState,
  property: SyntaxNode,
): string | null {
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
 * The setting or group a node names, for the hover card. Both halves of a property answer:
 * the name ("what is this setting?") and the value ("what else could this be?").
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
