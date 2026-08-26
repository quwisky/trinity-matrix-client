import { CompletionContext } from '@codemirror/autocomplete';
import { json } from '@codemirror/lang-json';
import { EditorState } from '@codemirror/state';
import {
  configJsonSchema,
  planConfigApply,
  type ConfigApplyPlan,
  type ConfigEntry,
  type ConfigValue,
} from '@trinity/platform-native';
import { describe, expect, it } from 'vitest';
import {
  configCompletionSource,
  configDiagnostics,
  configHoverInfo,
} from './config-intellisense';

/**
 * A registry the shape of the real one — a closed choice, a flag, and a setting whose value is
 * an object or nothing — so the editor is driven by a `ConfigEntry` list exactly as it is in
 * the app, and the schema under test is the one `configJsonSchema` really generates.
 */
const PALETTES = ['trinity', 'amethyst'];

function entry(
  path: string,
  overrides: Partial<ConfigEntry> & Pick<ConfigEntry, 'description' | 'type'>,
): ConfigEntry {
  let held: ConfigValue = null;
  return {
    path,
    key: `trinity.${path}`,
    read: () => held,
    reset: () => undefined,
    write: (value) => {
      held = value;
    },
    validate: (value) => ({ ok: true, value: value as ConfigValue }),
    ...overrides,
  };
}

const ENTRIES: readonly ConfigEntry[] = [
  entry('theme.palette', {
    description: 'The accent colour the whole app is themed from.',
    type: 'string',
    choices: PALETTES,
    read: () => 'trinity',
    validate: (value) =>
      typeof value === 'string' && PALETTES.indexOf(value) >= 0
        ? { ok: true, value }
        : {
            ok: false,
            problem: `'${String(value)}' is not a known palette (expected trinity, amethyst or onyx)`,
          },
  }),
  entry('theme.mode', {
    description: 'Whether the app follows your system theme.',
    type: 'string',
    choices: ['system', 'light', 'dark'],
    read: () => 'system',
  }),
  entry('privacy.linkPreviews', {
    description: 'Whether links in messages are expanded into previews.',
    type: 'boolean',
    read: () => true,
    validate: (value) =>
      typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, problem: 'is not true or false' },
  }),
  entry('push.gateway', {
    description: 'The push gateway your notifications are routed through.',
    type: ['object', 'null'],
    read: () => null,
  }),
];

const SCHEMA = configJsonSchema(ENTRIES);
const complete = configCompletionSource(SCHEMA);

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [json()] });
}

/** The completion labels offered at `|` in the document, in the order they are offered. */
function labelsAt(docWithCaret: string): readonly string[] {
  const pos = docWithCaret.indexOf('|');
  const state = stateOf(docWithCaret.replace('|', ''));
  const result = complete(new CompletionContext(state, pos, true));
  return result ? result.options.map((option) => option.label) : [];
}

/** What a completion would actually insert. */
function applyAt(docWithCaret: string, label: string): string | undefined {
  const pos = docWithCaret.indexOf('|');
  const state = stateOf(docWithCaret.replace('|', ''));
  const result = complete(new CompletionContext(state, pos, true));
  const option = result?.options.find((candidate) => candidate.label === label);
  return typeof option?.apply === 'string' ? option.apply : undefined;
}

/** The plan `AppConfigService.validateJson` would build for this text. */
function planFor(text: string): ConfigApplyPlan {
  try {
    return planConfigApply(JSON.parse(text) as unknown, ENTRIES);
  } catch {
    return {
      ok: false,
      problems: ['This is not valid JSON: unexpected token'],
      warnings: [],
    };
  }
}

function documentOf(settings: object): string {
  return JSON.stringify(
    { version: 1, exportedAt: '2026-08-09T00:00:00.000Z', settings },
    null,
    2,
  );
}

describe('config completion', () => {
  it('offers the settings a group holds while a key is being typed', () => {
    const labels = labelsAt('{"settings":{"theme":{"pa|":"x"}}}');

    expect(labels).toContain('palette');
    expect(labels).toContain('mode');
    // A different group's settings are not offered here: the path is what scopes the list.
    expect(labels).not.toContain('linkPreviews');
  });

  it('does not offer a key the object already has', () => {
    const labels = labelsAt('{"settings":{"theme":{"mode":"dark","p|":null}}}');

    expect(labels).toContain('palette');
    expect(labels).not.toContain('mode');
  });

  it('offers the envelope at the top level, not the settings', () => {
    const labels = labelsAt('{"|":1}');

    expect(labels).toEqual(['exportedAt', 'settings', 'version']);
  });

  it('offers exactly the values the setting accepts, inside its quotes', () => {
    // The reason the whole feature exists: 'mauve' vs 'amethyst' is the mistake people make,
    // and the accepted set is declared once, beside the validator that enforces it.
    expect(labelsAt('{"settings":{"theme":{"palette":"am|"}}}')).toEqual(
      PALETTES,
    );
    // Already inside a string, so the completion replaces what is between the quotes and
    // must not bring quotes of its own — `""amethyst""` is the classic version of this bug.
    expect(
      applyAt('{"settings":{"theme":{"palette":"am|"}}}', 'amethyst'),
    ).toBe('amethyst');
  });

  it('brings its own quotes when the value has not been started', () => {
    expect(labelsAt('{"settings":{"theme":{"palette": |}}}')).toEqual(PALETTES);
    expect(applyAt('{"settings":{"theme":{"palette": |}}}', 'amethyst')).toBe(
      '"amethyst"',
    );
  });

  it('offers the JSON literals a setting takes when it is not a closed choice', () => {
    expect(labelsAt('{"settings":{"privacy":{"linkPreviews": |}}}')).toEqual([
      'false',
      'true',
    ]);
    expect(labelsAt('{"settings":{"push":{"gateway": |}}}')).toEqual(['null']);
  });

  it('offers a key after an opening brace or a comma', () => {
    expect(labelsAt('{"settings":{"theme":{|}}}')).toContain('palette');
    expect(labelsAt('{"settings":{"theme":{"mode":"dark",|}}}')).toContain(
      'palette',
    );
  });

  it('offers nothing where the document says nothing', () => {
    // Mid-value in free text: guessing here would offer settings for a path nobody is on.
    expect(labelsAt('{"settings":{"theme":{"palette":"trinity"}}}|')).toEqual(
      [],
    );
  });
});

describe('config hover', () => {
  const doc = documentOf({ theme: { palette: 'trinity' } });

  it('describes the setting under the key, with everything it accepts', () => {
    const state = stateOf(doc);
    const info = configHoverInfo(SCHEMA, state, doc.indexOf('"palette"') + 2);

    expect(info?.path).toBe('settings.theme.palette');
    expect(info?.description).toContain('accent colour');
    expect(info?.choices).toEqual(PALETTES);
    expect(info?.type).toBe('string');
  });

  it('describes it under the value too, which is where the question is asked', () => {
    const state = stateOf(doc);
    const info = configHoverInfo(SCHEMA, state, doc.indexOf('"trinity"') + 2);

    expect(info?.path).toBe('settings.theme.palette');
    expect(state.sliceDoc(info?.from, info?.to)).toBe('"trinity"');
  });

  it('names both JSON types where a setting has two', () => {
    const gateway = documentOf({ push: { gateway: null } });
    const state = stateOf(gateway);
    const info = configHoverInfo(
      SCHEMA,
      state,
      gateway.indexOf('"gateway"') + 2,
    );

    expect(info?.type).toBe('object or null');
  });

  it('says nothing about a path this build does not have', () => {
    const unknown = documentOf({ theme: { fromTheFuture: 'x' } });
    const state = stateOf(unknown);

    expect(
      configHoverInfo(SCHEMA, state, unknown.indexOf('"fromTheFuture"') + 2),
    ).toBeNull();
  });
});

describe('config diagnostics', () => {
  it('underlines the refused value, with the reason the Apply gate gives', () => {
    const doc = documentOf({ theme: { palette: 'mauve' } });
    const state = stateOf(doc);

    const [diagnostic] = configDiagnostics(state, planFor(doc));

    expect(diagnostic.severity).toBe('error');
    // The offending *value*, not the whole line and not the key.
    expect(state.sliceDoc(diagnostic.from, diagnostic.to)).toBe('"mauve"');
    // The path is already the range, so the message is only the reason.
    expect(diagnostic.message).toBe(
      "'mauve' is not a known palette (expected trinity, amethyst or onyx)",
    );
  });

  it('underlines the key of a setting this build does not have, as a warning', () => {
    const doc = documentOf({ theme: { fromTheFuture: 'x' } });
    const state = stateOf(doc);

    const diagnostics = configDiagnostics(state, planFor(doc));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(state.sliceDoc(diagnostics[0].from, diagnostics[0].to)).toBe(
      '"fromTheFuture"',
    );
  });

  it('marks where the JSON broke, and does not repeat itself in prose', () => {
    const doc = '{"version": 1, "settings": {"theme": {';
    const state = stateOf(doc);

    const diagnostics = configDiagnostics(state, planFor(doc));

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((one) => one.severity === 'error')).toBe(true);
    // The plan's pathless "this is not valid JSON" would land on line 1 and say nothing the
    // underline does not already say.
    expect(
      diagnostics.some((one) => one.message.includes('not valid JSON')),
    ).toBe(false);
  });

  it('puts a problem about the document as a whole on its first line', () => {
    const doc = JSON.stringify({ settings: {} }, null, 2);
    const state = stateOf(doc);

    const [diagnostic] = configDiagnostics(state, planFor(doc));

    expect(diagnostic.message).toContain('no version number');
    expect(diagnostic.from).toBe(0);
    expect(diagnostic.to).toBe(state.doc.lineAt(0).to);
  });

  it('finds nothing wrong with a document the Apply gate accepts', () => {
    const doc = documentOf({ theme: { palette: 'amethyst' } });

    expect(configDiagnostics(stateOf(doc), planFor(doc))).toEqual([]);
  });
});
