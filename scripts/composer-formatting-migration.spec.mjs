import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/composer-formatting.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const navigationSource = 'e2e/support/journeys/navigation.mts';
const contractPath = resolve(
  root,
  'e2e/android/composer-formatting-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/composer-formatting-journeys.mts',
);
const clientPath = resolve(root, 'e2e/android/account-workspace-client.mts');

const assertionIds = [
  'composer-formatting.apply.composer-ready',
  'composer-formatting.apply.target-width',
  'composer-formatting.apply.target-height',
  'composer-formatting.apply.sheet-visible',
  'composer-formatting.apply.sheet-measured',
  'composer-formatting.apply.sheet-left-bound',
  'composer-formatting.apply.sheet-right-bound',
  'composer-formatting.apply.sheet-top-bound',
  'composer-formatting.apply.sheet-bottom-bound',
  'composer-formatting.apply.formatted-value',
  'composer-formatting.apply.sheet-hidden',
  'composer-formatting.apply.composer-focused',
  'composer-formatting.preview.composer-ready',
  'composer-formatting.preview.cancel-hidden',
  'composer-formatting.preview.cancel-value',
  'composer-formatting.preview.cancel-selection-start',
  'composer-formatting.preview.cancel-selection-end',
  'composer-formatting.preview.bold-content',
  'composer-formatting.preview.preview-hidden',
  'composer-formatting.preview.composer-focused',
  'composer-formatting.preview.selection-start',
  'composer-formatting.preview.selection-end',
  'composer-formatting.preview.send-visible',
  'composer-formatting.compact.composer-ready',
  'composer-formatting.compact.composer-visible',
  'composer-formatting.compact.root-font-size',
  'composer-formatting.compact.format-visible',
  'composer-formatting.compact.format-width',
  'composer-formatting.compact.format-height',
  'composer-formatting.compact.format-left-bound',
  'composer-formatting.compact.format-right-bound',
  'composer-formatting.compact.send-visible',
  'composer-formatting.compact.send-width',
  'composer-formatting.compact.send-height',
  'composer-formatting.compact.send-left-bound',
  'composer-formatting.compact.send-right-bound',
  'composer-formatting.compact.preview-content',
  'composer-formatting.compact.composer-focused',
  'composer-formatting.compact.composer-value',
];

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

function sourceLines(path, expectedHash) {
  const contents = readFileSync(resolve(root, path));
  expect(createHash('sha256').update(contents).digest('hex')).toBe(
    expectedHash,
  );
  return contents.toString('utf8').split('\n');
}

function assertRuntimeContract(journey, client) {
  const requiredJourneyFragments = [
    "id: 'apply-selected-italic'",
    "id: 'cancel-and-preview'",
    "id: 'compact-larger-text'",
    'expectedStages: 3',
    'expectedUniqueAssertions: 39',
    'expectedAssertionRecords: 39',
    'attempt: 1',
    'retries: 0',
    'await client.selectWordCurrent(COMPOSER,',
    "await client.fillFocused(COMPOSER, 'say hello')",
    "await client.fillFocused(COMPOSER, '**bold** and plain')",
    "await client.fillFocused(COMPOSER, 'compact draft')",
    'assert(trigger.rect.width >= 44)',
    'assert(trigger.rect.height >= 44)',
    'assert(sheet.rect.right <= viewport.rect.width + 0.5)',
    'assert(sheet.rect.bottom <= viewport.rect.height + 0.5)',
    "const formatted = 'say *hello*'",
    "for (const selectedWord of ['hello', 'bold'] as const)",
    'selected word is absent as an exact JSON value from ${path}',
    'const result = await exactComposer(client, formatted, { focused: true })',
    "matches: bold.renderedText === 'bold'",
    'await client.tapCurrent(\'[data-testid="format-italic"]\')',
    'await client.tapCurrent(\'[data-testid="format-cancel"]\')',
    'await client.tapCurrent(\'[data-testid="format-preview"]\')',
    'await client.tapCurrent(\'[data-testid="open-settings"]\')',
    'await client.tapCurrent(\'[data-testid="settings-nav-appearance"]\')',
    'await client.tapCurrent(\'[data-testid="text-scale-select"] button\')',
    'await client.tapCurrent(\'[data-testid="text-scale-larger"]\')',
    'await client.relaunch(COMPACT_LARGER_PROFILE)',
    "fontSize === '20px'",
    'control.rect.width >= 44',
    'control.rect.height >= 44',
    'control.rect.right <= 320.5',
    'redactMaestroArtifacts(output, secrets, false)',
    "'the modal action sheet occludes the composer draft in the full viewport capture'",
    'scanComposerFormattingArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of requiredJourneyFragments)
    expect(journey).toContain(fragment);

  for (const [stageStart, stageEnd] of [
    [
      'async function runApplySelectedItalic(',
      'async function runCancelAndPreview(',
    ],
    [
      'async function runCancelAndPreview(',
      'async function runCompactLargerText(',
    ],
  ]) {
    const stage = journey.slice(
      journey.indexOf(stageStart),
      journey.indexOf(stageEnd),
    );
    expect(stage.indexOf('await client.hideKeyboard();')).toBeGreaterThan(-1);
    expect(stage.indexOf('await client.hideKeyboard();')).toBeLessThan(
      stage.indexOf('await client.selectWordCurrent(COMPOSER,'),
    );
  }

  const selection = client.slice(
    client.indexOf('async selectWordCurrent('),
    client.indexOf(
      'async tapDocumentTrigger(',
      client.indexOf('async selectWordCurrent('),
    ),
  );
  expect(selection).toContain('OffscreenCanvas');
  expect(selection).toContain('measureText');
  expect(selection).toContain('duration: ${LONG_PRESS_DURATION_MS}');
  expect(selection).toContain('WORD_SELECTION_MINIMUM_OBSERVED_MS');
  expect(selection).toContain(
    'observedDurationMs >= WORD_SELECTION_MINIMUM_OBSERVED_MS',
  );
  expect(selection).toContain('this.owner.nativePoint');
  expect(selection).toContain('selectionStart');
  expect(selection).toContain('selectionEnd');
  expect(selection).toContain('trusted');
  expect(selection).not.toMatch(/\.focus\s*\(|setSelectionRange\s*\(/u);

  const keyboard = client.slice(
    client.indexOf('async hideKeyboard('),
    client.indexOf(
      'installDocumentScript(',
      client.indexOf('async hideKeyboard('),
    ),
  );
  expect(keyboard).toContain("'dumpsys'");
  expect(keyboard).toContain('mInputShown=true');
  expect(keyboard).toContain(
    "action: shown ? 'maestro-hideKeyboard' : 'already-hidden'",
  );
  expect(keyboard.indexOf('if (!shown)')).toBeLessThan(
    keyboard.indexOf('this.device.runFlow'),
  );

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toContain('client.capture(');
  expect(journey).not.toContain('text: bold.renderedText');
  expect(journey).not.toContain('SECRET_APPLY_SELECTED_WORD');
  expect(journey).not.toContain('SECRET_PREVIEW_SELECTED_WORD');
  expect(journey).not.toMatch(
    /evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit|setSelectionRange)\s*\(/u,
  );
  expect(journey.match(/selectionStart: 2/gu)).toHaveLength(3);
  expect(journey.match(/selectionEnd: 6/gu)).toHaveLength(3);
  expect(selection).toContain('observed.selectionStart === initial.wordStart');
  expect(selection).toContain('observed.selectionEnd === initial.wordEnd');
}

describe('Android composer-formatting migration', () => {
  it('pins the exact predecessor and shared-helper sources', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '3e346da10d6b38c10928a824333f050916009fddffd3215331d4bcf723672b8c',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );
    sourceLines(
      navigationSource,
      '43232dafbf9e80df6977442f366974100ccfa315b20ab680f893d4300ab46f81',
    );

    expect(predecessor[30]).toContain('async function openComposer');
    expect(predecessor[85]).toContain('await expect(input).toBeVisible');
    expect(predecessor[97]).toContain('async function selectWord');
    expect(predecessor[102]).toContain('input.setSelectionRange');
    expect(predecessor[583]).toContain(
      "test('uses a bounded touch action sheet and applies selected text'",
    );
    expect(predecessor[620]).toContain(
      "test('cancels and previews on mobile without losing the selected text'",
    );
    expect(predecessor[657]).toContain(
      "test('keeps Format and Send reachable at compact width with larger text'",
    );
    expect(
      predecessor
        .slice(583, 620)
        .join('\n')
        .match(/\bexpect\b/gu),
    ).toHaveLength(11);
    expect(
      predecessor
        .slice(620, 657)
        .join('\n')
        .match(/\bexpect\b/gu),
    ).toHaveLength(10);
    // Five expect sites live in a two-control loop, so the definition expands
    // to 10 loop assertions plus five one-off assertions at runtime.
    expect(
      predecessor
        .slice(657, 697)
        .join('\n')
        .match(/\bexpect\b/gu),
    ).toHaveLength(10);
    expect(predecessor.slice(114, 574).join('\n')).toContain(
      "process.env['TRINITY_E2E_PLATFORM'] === 'android'",
    );
  });

  it('exports all 39 unique parity identities and exact source mapping', async () => {
    expect(
      contractPath,
      'composer-formatting-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.COMPOSER_FORMATTING_SOURCES).toEqual({
      helpers: `${predecessorSource}:28-113`,
      apply: `${predecessorSource}:584-620`,
      preview: `${predecessorSource}:621-657`,
      compact: `${predecessorSource}:658-697`,
      app: appSource,
      account: accountSource,
      navigation: navigationSource,
    });
    expect(Object.values(contract.composerFormattingAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.composerFormattingAssertions)).size,
    ).toBe(39);
    expect(contract.COMPOSER_FORMATTING_ASSERTION_RECORDS).toBe(39);
  });

  it('uses trusted native selection, native Settings, cold restore, and exact cleanup', () => {
    const journey = readIfPresent(journeyPath);
    const client = read(clientPath);
    expect(journey, 'composer-formatting-journeys.mts must exist').not.toBe('');
    assertRuntimeContract(journey, client);
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when selection, bounds, formatting, continuity, compact reachability, redaction, or cleanup is weakened', () => {
    const journey = readIfPresent(journeyPath);
    const client = read(clientPath);
    expect(() => assertRuntimeContract(journey, client)).not.toThrow();
    const journeyMutations = [
      ['assert(trigger.rect.width >= 44)', 'assert(trigger.rect.width >= 4)'],
      [
        'assert(sheet.rect.right <= viewport.rect.width + 0.5)',
        'assert(sheet.rect.right <= viewport.rect.width + 50)',
      ],
      ["const formatted = 'say *hello*'", "const formatted = 'say hello'"],
      ["matches: bold.renderedText === 'bold'", 'text: bold.renderedText'],
      [
        "for (const selectedWord of ['hello', 'bold'] as const)",
        'for (const selectedWord of [] as const)',
      ],
      ['selectionStart: 2', 'selectionStart: 1'],
      ['control.rect.width >= 44', 'control.rect.width >= 4'],
      ['control.rect.right <= 320.5', 'control.rect.right <= 420.5'],
      ['redactMaestroArtifacts(output, secrets, false)', 'Promise.resolve()'],
      ['scanComposerFormattingArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await client.close()', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ];
    for (const [before, after] of journeyMutations) {
      expect(journey).toContain(before);
      const mutated =
        before === 'selectionStart: 2'
          ? journey.replaceAll(before, after)
          : journey.replace(before, after);
      expect(() => assertRuntimeContract(mutated, client)).toThrow();
    }

    for (const [before, after] of [
      [
        'observed.selectionEnd === initial.wordEnd',
        'observed.selectionEnd === initial.wordStart',
      ],
      [
        'observedDurationMs >= WORD_SELECTION_MINIMUM_OBSERVED_MS',
        'observedDurationMs >= 0',
      ],
    ]) {
      expect(client).toContain(before);
      expect(
        () => assertRuntimeContract(journey, client.replace(before, after)),
        `mutation must fail closed: ${before}`,
      ).toThrow();
    }
  });

  it('wires one-attempt Android execution, registry ownership, and started-only CI diagnostics', () => {
    const project = read('e2e/android/project.json');
    const registry = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const packageJson = read('package.json');

    expect(project).toContain('"composer-formatting"');
    expect(project).toContain('--suite=android.composer-formatting');
    expect(project).toContain(
      '--entrypoint=e2e/android/composer-formatting-journeys.mts',
    );
    expect(registry).toContain("id: 'android.composer-formatting'");
    expect(commands).toContain("name: 'e2e:android:composer-formatting'");
    expect(packageJson).toContain('"e2e:android:composer-formatting"');
    expect(workflow).toContain('composer-formatting-started=true');
    expect(workflow).toContain('android-composer-formatting');
    expect(workflow).toContain('android.composer-formatting/**');
  });
});
