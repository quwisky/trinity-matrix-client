import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from './app-config.service';
import {
  CONFIG_SCHEMA_DIALECT,
  CONFIG_SCHEMA_ID,
  configJsonSchema,
  type ConfigSchemaNode,
} from './config-json-schema';
import {
  CONFIG_EXPORT_VERSION,
  type ConfigEntry,
  type ConfigJsonType,
} from './config-schema';
import { choiceSetting, flagSetting } from './config-validation';
import { providePlatformConfigEntries } from './platform-config-entries';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
}));

/** The app's wiring, as `main.ts` does it for this lib's share of the registry. */
function platformEntries(): readonly ConfigEntry[] {
  TestBed.configureTestingModule({
    providers: [providePlatformConfigEntries()],
  });
  return TestBed.inject(AppConfigService).entries;
}

function entry(spec: {
  readonly path: string;
  readonly description: string;
  readonly type: ConfigJsonType | readonly ConfigJsonType[];
  readonly rest: Pick<ConfigEntry, 'validate' | 'write' | 'type' | 'choices'>;
}): ConfigEntry {
  return {
    path: spec.path,
    key: `stored:${spec.path}`,
    description: spec.description,
    read: () => null,
    reset: () => undefined,
    ...spec.rest,
    type: spec.type,
  };
}

/** Two settings, covering both shapes the generator renders: a closed choice and a flag. */
function sampleEntries(): readonly ConfigEntry[] {
  const isMode = (value: string): value is 'light' | 'dark' =>
    value === 'light' || value === 'dark';
  return [
    entry({
      path: 'theme.mode',
      description: 'Light or dark.',
      type: 'string',
      rest: choiceSetting({
        isValid: isMode,
        options: ['light', 'dark'],
        noun: 'a theme mode',
        set: () => undefined,
      }),
    }),
    entry({
      path: 'privacy.linkPreviews',
      description: 'Whether links are expanded into previews.',
      type: 'boolean',
      rest: flagSetting(() => undefined),
    }),
  ];
}

describe('configJsonSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
  });

  it('is a draft 2020-12 document that identifies the format it describes', () => {
    const schema = configJsonSchema(sampleEntries());

    expect(schema.$schema).toBe(CONFIG_SCHEMA_DIALECT);
    expect(schema.$id).toBe(CONFIG_SCHEMA_ID);
    expect(schema.title).toBe('Trinity configuration export');
    // The `$id` names a version of the format, so it cannot be paired with a document the
    // envelope stamps differently.
    expect(schema.$id).toContain(`v${CONFIG_EXPORT_VERSION}`);
  });

  it('describes the whole envelope, with the version pinned to a constant', () => {
    const schema = configJsonSchema(sampleEntries());

    expect(schema.required).toEqual(['version', 'settings']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.['version'].const).toBe(CONFIG_EXPORT_VERSION);
    expect(schema.properties?.['exportedAt'].type).toBe('string');
  });

  it('renders a setting as its type, its accepted set and its description', () => {
    const schema = configJsonSchema(sampleEntries());

    expect(leaf(schema.properties?.['settings'], 'theme.mode')).toEqual({
      type: 'string',
      enum: ['light', 'dark'],
      description: 'Light or dark.',
    });
    expect(
      leaf(schema.properties?.['settings'], 'privacy.linkPreviews'),
    ).toEqual({
      type: 'boolean',
      description: 'Whether links are expanded into previews.',
    });
  });

  it('closes every group, so a mistyped path is a diagnostic and not a silent no-op', () => {
    const schema = configJsonSchema(sampleEntries());
    const settings = schema.properties?.['settings'];

    expect(settings?.additionalProperties).toBe(false);
    expect(settings?.properties?.['theme'].additionalProperties).toBe(false);
    // Nothing is `required`: a document that sets one preference is legitimate, and the
    // reader leaves every absent setting alone.
    expect(settings?.properties?.['theme'].required).toBeUndefined();
  });

  it('stringifies the same whatever order the libraries registered in', () => {
    const forwards = configJsonSchema(sampleEntries());
    const backwards = configJsonSchema(sampleEntries().slice().reverse());

    // Byte-for-byte, not `toEqual`: the point of sorting the keys is that two builds of the
    // same registry produce the same file, so a diff between two exports of the schema shows
    // a format change rather than an injection order.
    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards));
  });

  it('emits every generated object with its keys in sorted order', () => {
    const schema = configJsonSchema(platformEntries());

    for (const keys of propertyKeys(schema.properties?.['settings'])) {
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('pins the wire shape of a document', () => {
    expect(JSON.stringify(configJsonSchema(sampleEntries()), null, 2))
      .toMatchInlineSnapshot(`
      "{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://qwky.eu/trinity/config-v3.schema.json",
        "title": "Trinity configuration export",
        "type": "object",
        "description": "A Trinity configuration export: the local preference layer of one device, in a versioned envelope. It carries no accounts, no access tokens and no message content.",
        "additionalProperties": false,
        "required": [
          "version",
          "settings"
        ],
        "properties": {
          "exportedAt": {
            "type": "string",
            "description": "When the export was taken, as an ISO-8601 timestamp. Informational: nothing is decided from it on import."
          },
          "settings": {
            "type": "object",
            "description": "Every setting this build knows, grouped by the part of the app that owns it. A setting left out is left alone on import, so a document that sets one preference is a legitimate document.",
            "additionalProperties": false,
            "properties": {
              "privacy": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "linkPreviews": {
                    "type": "boolean",
                    "description": "Whether links are expanded into previews."
                  }
                }
              },
              "theme": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "mode": {
                    "type": "string",
                    "enum": [
                      "light",
                      "dark"
                    ],
                    "description": "Light or dark."
                  }
                }
              }
            }
          },
          "version": {
            "const": 3,
            "description": "The format version. A document from a newer version is read as far as this build understands it, and what it cannot apply is named rather than dropped silently."
          }
        }
      }"
    `);
  });

  it('describes every setting this lib registers, and nothing it does not', () => {
    const entries = platformEntries();
    const schema = configJsonSchema(entries);

    expect(paths(schema.properties?.['settings'], '')).toEqual(
      entries.map((registered) => registered.path).sort(),
    );
  });
});

function leaf(
  node: ConfigSchemaNode | undefined,
  path: string,
): ConfigSchemaNode | undefined {
  let found = node;
  for (const segment of path.split('.')) {
    found = found?.properties?.[segment];
  }
  return found;
}

/** The property-key lists of every group in the tree, outermost first. */
function propertyKeys(node: ConfigSchemaNode | undefined): string[][] {
  if (!node?.properties) {
    return [];
  }
  const lists = [Object.keys(node.properties)];
  for (const child of Object.values(node.properties)) {
    for (const nested of propertyKeys(child)) {
      lists.push(nested);
    }
  }
  return lists;
}

function paths(node: ConfigSchemaNode | undefined, prefix: string): string[] {
  if (!node?.properties) {
    return prefix ? [prefix] : [];
  }
  const found: string[] = [];
  for (const [key, child] of Object.entries(node.properties)) {
    for (const nested of paths(child, prefix ? `${prefix}.${key}` : key)) {
      found.push(nested);
    }
  }
  return found;
}
