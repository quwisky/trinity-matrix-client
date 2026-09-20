import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/composer-typing.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const fixturePath = resolve(root, 'e2e/android/account-workspace-fixtures.mts');
const contractPath = resolve(root, 'e2e/android/composer-typing-contract.mts');
const journeyPath = resolve(root, 'e2e/android/composer-typing-journeys.mts');

const groupedAssertionIds = {
  showClear: [
    'composer-typing.show-clear.composer-ready',
    'composer-typing.show-clear.indicator-visible',
    'composer-typing.show-clear.exact-copy',
    'composer-typing.show-clear.hidden-after-stop',
  ],
  reservedSlot: [
    'composer-typing.reserved-slot.composer-ready',
    'composer-typing.reserved-slot.idle-height-positive',
    'composer-typing.reserved-slot.indicator-visible',
    'composer-typing.reserved-slot.height-stable',
  ],
  longName: [
    'composer-typing.long-name.composer-ready',
    'composer-typing.long-name.idle-height-positive',
    'composer-typing.long-name.indicator-visible',
    'composer-typing.long-name.height-stable',
    'composer-typing.long-name.text-overflows',
  ],
  liveAnimation: [
    'composer-typing.live-animation.composer-ready',
    'composer-typing.live-animation.indicator-visible',
    'composer-typing.live-animation.one-animation',
    'composer-typing.live-animation.duration-1000ms',
    'composer-typing.live-animation.infinite-iterations',
  ],
  reducedMotion: [
    'composer-typing.reduced-motion.composer-ready',
    'composer-typing.reduced-motion.indicator-visible',
    'composer-typing.reduced-motion.full-opacity-dots',
  ],
  sidebarProjection: [
    'composer-typing.sidebar-projection.composer-ready',
    'composer-typing.sidebar-projection.exact-copy',
    'composer-typing.sidebar-projection.clears',
    'composer-typing.sidebar-projection.local-keeps-exact-copy',
  ],
};
const assertionIds = Object.values(groupedAssertionIds).flat();

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

function assertRuntimeContract(journey, fixtures) {
  const journeyFragments = [
    "id: 'show-clear'",
    "id: 'reserved-slot'",
    "id: 'long-name'",
    "id: 'live-animation'",
    "id: 'reduced-motion'",
    "id: 'sidebar-projection'",
    'expectedStages: 6',
    'expectedUniqueAssertions: 25',
    'expectedAssertionRecords: 25',
    'attempt: 1',
    'retries: 0',
    'expectedAssertionRecords: 4',
    'expectedAssertionRecords: 5',
    'expectedAssertionRecords: 3',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    'await client.fill(\'[data-testid="composer-input"]\', localDraft)',
    'await fixtures.setTyping(member, room.id, true)',
    'await fixtures.setTyping(member, room.id, false)',
    'const indicator = \'[data-testid="typing-indicator"]\'',
    '`${member.displayName} is typing`',
    "const slot = await observeTypingSlot(client, '.typing-slot')",
    'assert(slot.height > 0',
    'Math.abs(occupied.height - idle.height) < 1',
    "'Alexandra Wellington-Fitzgerald the Third of Northumberland and Wessex'",
    'text.scrollWidth > text.clientWidth',
    "document.querySelector('.typing-dots__dot')",
    'element.getAnimations()',
    'timing.duration === 1000',
    'timing.iterations === Infinity',
    "'animator_duration_scale'",
    "'0'",
    "matchMedia('(prefers-reduced-motion: reduce)').matches",
    "assert.deepEqual(opacities, ['1', '1', '1'])",
    'await restoreAnimatorDurationScale(',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanComposerTypingArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of journeyFragments) expect(journey).toContain(fragment);

  const fixtureFragments = [
    'setTyping(',
    '${SYNAPSE_HTTP}/_matrix/client/v3${path}',
    '/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(account.userId)}',
    'typing ? { typing: true, timeout: 30_000 } : { typing: false }',
    'signal',
  ];
  for (const fragment of fixtureFragments) expect(fixtures).toContain(fragment);

  expect(journey.match(/expectedAssertionRecords: 4/gu)).toHaveLength(3);
  expect(journey.match(/expectedAssertionRecords: 5/gu)).toHaveLength(2);
  expect(journey.match(/expectedAssertionRecords: 3/gu)).toHaveLength(1);
  expect(
    journey.match(/await fixtures\.setTyping\([^,]+,[^,]+, false\)/gu),
  ).not.toHaveLength(0);
  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  const sourceFile = ts.createSourceFile(
    journeyPath,
    journey,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rendererExpressions = [];
  function collectRendererExpressions(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'evaluateNative'
    ) {
      expect(node.arguments).toHaveLength(2);
      rendererExpressions.push(node.arguments[1].getText(sourceFile));
    }
    ts.forEachChild(node, collectRendererExpressions);
  }
  collectRendererExpressions(sourceFile);
  expect(rendererExpressions.length).toBeGreaterThan(0);
  for (const expression of rendererExpressions) {
    expect(expression).not.toMatch(
      /\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
    );
    expect(expression).not.toMatch(
      /style\.|setAttribute\(|dispatchEvent\(|\.value\s*=/u,
    );
  }
  expect(journey).not.toMatch(
    /Emulation\.setEmulatedMedia|page\.emulateMedia|setEmulatedMedia/u,
  );
}

describe('Android composer-typing migration', () => {
  it('pins the exact predecessor, helper spans, and 19 + 6 parity shape', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '721a2dd22902ad0683c95b95e819ec3519c22b9d362b3c58a9893e60ec229f8f',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[21]).toContain('async function apiToken');
    expect(predecessor[43]).toContain('async function seedRoomWithMember');
    expect(predecessor[97]).toContain('async function setMemberTyping');
    expect(predecessor[113]).toContain('async function openRoom');
    expect(predecessor[118]).toContain("getByTestId('composer-input')");

    const definitions = [
      [126, 153, 3],
      [156, 197, 3],
      [203, 249, 4],
      [250, 283, 4],
      [284, 319, 2],
      [320, 356, 3],
    ];
    for (const [start, end, directAssertions] of definitions) {
      const definition = predecessor.slice(start, end).join('\n');
      expect(definition.match(/\bexpect\b/gu)).toHaveLength(directAssertions);
      expect(definition.match(/await openRoom\(/gu)).toHaveLength(1);
    }
    expect(definitions.reduce((total, entry) => total + entry[2], 0)).toBe(19);
    expect(predecessor.slice(21, 122).join('\n')).toContain(
      'typing ? { typing: true, timeout: 30_000 } : { typing: false }',
    );
  });

  it('exports all 25 unique identities in exact 4 + 4 + 5 + 5 + 3 + 4 groups', async () => {
    expect(contractPath, 'composer-typing-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.COMPOSER_TYPING_SOURCES).toEqual({
      helpers: `${predecessorSource}:22-122`,
      showClear: `${predecessorSource}:127-153`,
      reservedSlot: `${predecessorSource}:157-197`,
      longName: `${predecessorSource}:204-249`,
      liveAnimation: `${predecessorSource}:251-283`,
      reducedMotion: `${predecessorSource}:285-319`,
      sidebarProjection: `${predecessorSource}:321-356`,
      app: appSource,
      account: accountSource,
    });
    expect(contract.composerTypingStageAssertions).toEqual(groupedAssertionIds);
    expect(Object.values(contract.composerTypingAssertions)).toEqual(
      assertionIds,
    );
    expect(new Set(assertionIds).size).toBe(25);
    expect(contract.COMPOSER_TYPING_ASSERTION_RECORDS).toBe(25);
  });

  it('uses native product actions, exact Matrix typing, and read-only observations', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'composer-typing-journeys.mts must exist').not.toBe('');
    assertRuntimeContract(journey, readFileSync(fixturePath, 'utf8'));
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when parity, native ownership, reduced motion, teardown, or redaction weakens', () => {
    const journey = readIfPresent(journeyPath);
    const fixtures = readFileSync(fixturePath, 'utf8');
    expect(() => assertRuntimeContract(journey, fixtures)).not.toThrow();
    for (const [before, after] of [
      ['assert(slot.height > 0', 'assert(slot.height >= 0'],
      [
        'Math.abs(occupied.height - idle.height) < 1',
        'Math.abs(occupied.height - idle.height) < 2',
      ],
      ['text.scrollWidth > text.clientWidth', 'text.scrollWidth >= 0'],
      ['timing.duration === 1000', 'timing.duration > 0'],
      ['timing.iterations === Infinity', 'timing.iterations > 0'],
      ["matchMedia('(prefers-reduced-motion: reduce)').matches", 'true'],
      [
        "assert.deepEqual(opacities, ['1', '1', '1'])",
        'assert.equal(opacities.length, 3)',
      ],
      ['await restoreAnimatorDurationScale(', 'Promise.resolve('],
      ['redactMaestroArtifacts(output, secrets, true)', 'Promise.resolve()'],
      ['scanComposerTypingArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await client.close()', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ]) {
      expect(journey).toContain(before);
      expect(
        () =>
          assertRuntimeContract(journey.replaceAll(before, after), fixtures),
        `mutation must fail closed: ${before}`,
      ).toThrow();
    }
    expect(() =>
      assertRuntimeContract(
        journey,
        fixtures.replace(
          'typing ? { typing: true, timeout: 30_000 } : { typing: false }',
          '{ typing }',
        ),
      ),
    ).toThrow();
  });

  it('wires one-attempt Android execution, registry ownership, and started-only diagnostics', () => {
    const project = read('e2e/android/project.json');
    const registry = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const packageJson = read('package.json');
    const migration = read('e2e/android/MIGRATION.md');

    expect(project).toContain('"composer-typing"');
    expect(project).toContain('--suite=android.composer-typing');
    expect(project).toContain(
      '--entrypoint=e2e/android/composer-typing-journeys.mts',
    );
    expect(registry).toContain("id: 'android.composer-typing'");
    expect(commands).toContain("name: 'e2e:android:composer-typing'");
    expect(packageJson).toContain('"e2e:android:composer-typing"');
    expect(workflow).toContain('composer-typing-started=true');
    expect(workflow).toContain('android-composer-typing');
    expect(workflow).toContain('android.composer-typing/**');
    expect(migration).toContain('## Composer typing-indicator journeys');
  });
});
