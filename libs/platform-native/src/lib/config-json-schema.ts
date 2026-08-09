import {
  CONFIG_EXPORT_VERSION,
  type ConfigEntry,
  type ConfigJsonType,
} from './config-schema';

/**
 * The exported configuration described as a JSON Schema document.
 *
 * **This is a published artifact shape, not an internal convenience.** It is what the
 * in-app editor drives its completions, hover text and diagnostics from, and it is the thing
 * anyone outside this codebase would validate a Trinity config file against. Its `$id` names
 * a format, so it is subject to the same commitment as the envelope itself: a path renamed
 * or a `type` narrowed is a format change, and the version in the `$id` moves with
 * {@link CONFIG_EXPORT_VERSION}.
 *
 * It is generated from the live {@link ConfigEntry} registry rather than written by hand —
 * the registry already carries a description, a JSON type and, for a closed choice, the
 * accepted set, so a second hand-maintained copy of that could only ever be a way to be
 * wrong. `configSchemaDrift` proves the two still agree.
 *
 * The output is deterministic: every generated object's keys are emitted in sorted order, so
 * two builds of the same registry stringify byte-for-byte and the document can be snapshotted
 * and diffed.
 */

/** JSON Schema's own identifier for the dialect this document is written in. */
export const CONFIG_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema';

/**
 * The document's `$id`.
 *
 * An identifier, not a fetchable location — JSON Schema `$id`s are URIs so that two schemas
 * cannot collide, and nothing here or in any editor resolves it over the network. The
 * version in it tracks {@link CONFIG_EXPORT_VERSION}, so a document and the schema that
 * describes it can never be paired up wrongly.
 */
export const CONFIG_SCHEMA_ID = `https://qwky.eu/trinity/config-v${CONFIG_EXPORT_VERSION}.schema.json`;

/** The document's `title`. */
export const CONFIG_SCHEMA_TITLE = 'Trinity configuration export';

/**
 * One node of the generated schema — the subset of JSON Schema this generator emits, spelled
 * out rather than left open, so a keyword cannot be added to the published shape by accident.
 */
export interface ConfigSchemaNode {
  readonly type?: ConfigJsonType | readonly ConfigJsonType[];
  /** Only on `version`, which is a fixed number rather than a range of them. */
  readonly const?: number;
  /** The accepted set of a closed choice — {@link ConfigEntry.choices}, verbatim. */
  readonly enum?: readonly string[];
  readonly description?: string;
  readonly properties?: { readonly [key: string]: ConfigSchemaNode };
  readonly additionalProperties?: false;
  readonly required?: readonly string[];
}

/** The whole document: a {@link ConfigSchemaNode} carrying the identifying keywords. */
export interface ConfigJsonSchema extends ConfigSchemaNode {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
}

/** A group of settings while the tree is being built, or the setting at a leaf. */
type SchemaTree =
  | { readonly kind: 'group'; readonly children: Map<string, SchemaTree> }
  | { readonly kind: 'leaf'; readonly entry: ConfigEntry };

/**
 * Describe the registered settings as a JSON Schema 2020-12 document.
 *
 * Entries arrive as a parameter rather than through DI so the generator is pure and can be
 * read, tested and diffed without the injector — the same reason `planConfigApply` takes
 * them.
 *
 * A path that cannot be placed — a duplicate, or one that would have to be both a group and
 * a setting — is left out rather than allowed to overwrite its neighbour. That is a defect in
 * the registry, and silently dropping it is what makes it *findable*: `configSchemaDrift`
 * compares the generated leaves against the registry and names anything missing. Throwing
 * here instead would take down the editor and the export with it, and report the same fault
 * less clearly.
 */
export function configJsonSchema(
  entries: readonly ConfigEntry[],
): ConfigJsonSchema {
  return {
    $schema: CONFIG_SCHEMA_DIALECT,
    $id: CONFIG_SCHEMA_ID,
    title: CONFIG_SCHEMA_TITLE,
    type: 'object',
    description:
      'A Trinity configuration export: the local preference layer of one device, in a ' +
      'versioned envelope. It carries no accounts, no access tokens and no message content.',
    // Stricter than the reader, on purpose. `planConfigApply` ignores a top-level key it does
    // not know, but this describes a *published* envelope with exactly three fields, and an
    // unexpected one there means the file is not what it says it is. If `export()` ever gains
    // a `$schema` pointer (an open question on the PR, deliberately not decided here), it has
    // to be listed below in the same change.
    additionalProperties: false,
    required: ['version', 'settings'],
    properties: {
      exportedAt: {
        type: 'string',
        description:
          'When the export was taken, as an ISO-8601 timestamp. Informational: nothing is ' +
          'decided from it on import.',
      },
      settings: settingsNode(entries),
      version: {
        const: CONFIG_EXPORT_VERSION,
        description:
          'The format version. A document from a newer version is read as far as this ' +
          'build understands it, and what it cannot apply is named rather than dropped ' +
          'silently.',
      },
    },
  };
}

function settingsNode(entries: readonly ConfigEntry[]): ConfigSchemaNode {
  const root: SchemaTree = { kind: 'group', children: new Map() };
  // Sorted before insertion so a duplicate or a group/leaf collision is resolved the same way
  // whichever order the libraries happened to register in.
  const sorted = entries
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const entry of sorted) {
    insert(root, entry);
  }
  return {
    type: 'object',
    description:
      'Every setting this build knows, grouped by the part of the app that owns it. A ' +
      'setting left out is left alone on import, so a document that sets one preference ' +
      'is a legitimate document.',
    additionalProperties: false,
    properties: groupProperties(root),
  };
}

/** Place one entry at its path, refusing to overwrite anything already there. */
function insert(root: SchemaTree, entry: ConfigEntry): void {
  const segments = entry.path.split('.');
  let node = root;
  for (let depth = 0; depth < segments.length - 1; depth++) {
    if (node.kind !== 'group') {
      return;
    }
    const segment = segments[depth];
    let child = node.children.get(segment);
    if (!child) {
      child = { kind: 'group', children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  if (node.kind !== 'group') {
    return;
  }
  const leaf = segments[segments.length - 1];
  if (node.children.has(leaf)) {
    return;
  }
  node.children.set(leaf, { kind: 'leaf', entry });
}

function node(tree: SchemaTree): ConfigSchemaNode {
  // No `required` on a group: every setting is optional by design — the reader leaves an
  // absent one alone, so demanding them here would reject documents the app applies happily.
  return tree.kind === 'leaf'
    ? leafNode(tree.entry)
    : {
        type: 'object',
        additionalProperties: false,
        properties: groupProperties(tree),
      };
}

/** A group's children, keyed and emitted in sorted order — the source of the determinism. */
function groupProperties(tree: SchemaTree): {
  readonly [key: string]: ConfigSchemaNode;
} {
  const properties: { [key: string]: ConfigSchemaNode } = {};
  if (tree.kind !== 'group') {
    return properties;
  }
  for (const key of [...tree.children.keys()].sort()) {
    const child = tree.children.get(key);
    if (child) {
      properties[key] = node(child);
    }
  }
  return properties;
}

function leafNode(entry: ConfigEntry): ConfigSchemaNode {
  return entry.choices
    ? { type: entry.type, enum: entry.choices, description: entry.description }
    : { type: entry.type, description: entry.description };
}
