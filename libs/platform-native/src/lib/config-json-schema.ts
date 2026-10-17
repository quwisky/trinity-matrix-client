import {
  CONFIG_EXPORT_VERSION,
  type ConfigEntry,
  type ConfigJsonType,
} from './config-entry';

/**
 * The exported configuration described as a JSON Schema document.
 *
 * This is a published artifact shape: the in-app editor drives completions and
 * diagnostics from it, and outside users may validate config files against it. Its `$id`
 * names a format, so a renamed path or narrowed `type` is a format change, and the
 * version in the `$id` moves with {@link CONFIG_EXPORT_VERSION}.
 *
 * Generated from the live {@link ConfigEntry} registry, never hand-written; `configSchemaDrift`
 * proves the two still agree. Output is deterministic (keys emitted in sorted order), so
 * it can be snapshotted and diffed.
 */

/** JSON Schema's own identifier for the dialect this document is written in. */
export const CONFIG_SCHEMA_DIALECT =
  'https://json-schema.org/draft/2020-12/schema';

/**
 * The document's `$id`: an identifier, not a fetchable location; nothing resolves it over
 * the network. Its version tracks {@link CONFIG_EXPORT_VERSION}, so a document and its
 * schema can't be paired wrongly.
 */
export const CONFIG_SCHEMA_ID = `https://trinityproject.dev/trinity/config-v${CONFIG_EXPORT_VERSION}.schema.json`;

const CONFIG_SCHEMA_TITLE = 'Trinity configuration export';

/**
 * One node of the generated schema: the subset of JSON Schema this generator emits,
 * closed so a keyword can't enter the published shape by accident.
 */
export interface ConfigSchemaNode {
  readonly type?: ConfigJsonType | readonly ConfigJsonType[];
  /** Only on `version`, a fixed number. */
  readonly const?: number;
  /** The accepted set of a closed choice ({@link ConfigEntry.choices}). */
  readonly enum?: readonly string[];
  readonly description?: string;
  readonly properties?: { readonly [key: string]: ConfigSchemaNode };
  readonly additionalProperties?: false;
  readonly required?: readonly string[];
}

export interface ConfigJsonSchema extends ConfigSchemaNode {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
}

type SchemaTree =
  | { readonly kind: 'group'; readonly children: Map<string, SchemaTree> }
  | { readonly kind: 'leaf'; readonly entry: ConfigEntry };

/**
 * Describe the registered settings as a JSON Schema 2020-12 document.
 *
 * Entries arrive as a parameter, not through DI, so the generator stays pure.
 *
 * A path that cannot be placed (a duplicate, or one that must be both a group and a
 * setting) is left out rather than overwriting its neighbour. That is a registry defect,
 * and dropping it makes it findable: `configSchemaDrift` names anything missing. Throwing
 * would take down the editor and the export and report the same fault less clearly.
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
    // Stricter than the reader on purpose: `planConfigApply` ignores an unknown top-level
    // key, but this describes a published envelope with exactly three fields. A new
    // envelope field, such as a `$schema` pointer, must be listed below in the same change.
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
  // Sorted so a duplicate or group/leaf collision resolves the same way in any
  // registration order.
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
  // No `required` on a group: every setting is optional, as the reader leaves an absent
  // one alone.
  return tree.kind === 'leaf'
    ? leafNode(tree.entry)
    : {
        type: 'object',
        additionalProperties: false,
        properties: groupProperties(tree),
      };
}

/** A group's children in sorted key order, which makes the output deterministic. */
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
