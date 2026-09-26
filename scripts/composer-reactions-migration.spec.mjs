import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/composer-reactions.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/composer-reactions-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/composer-reactions-journeys.mts',
);

const assertionIds = [
  'composer-reactions.toggle.composer-ready',
  'composer-reactions.toggle.picker-visible',
  'composer-reactions.toggle.trigger-expanded',
  'composer-reactions.toggle.picker-hidden',
  'composer-reactions.toggle.trigger-collapsed',
  'composer-reactions.message.composer-ready',
  'composer-reactions.message.target-visible',
  'composer-reactions.message.dialog-visible',
  'composer-reactions.message.picker-visible',
  'composer-reactions.message.rocket-visible',
  'composer-reactions.message.exact-target-reaction',
  'composer-reactions.message.matrix-relation',
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

function assertRuntimeContract(journey, fixtures) {
  const requiredJourneyFragments = [
    "id: 'composer-toggle'",
    "id: 'message-reaction'",
    'expectedStages: 2',
    'expectedUniqueAssertions: 12',
    'expectedAssertionRecords: 12',
    'attempt: 1',
    'retries: 0',
    'expectedAssertionRecords: 5',
    'expectedAssertionRecords: 7',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    'await client.tapCurrent(\'button[aria-label="Insert emoji"]\')',
    "trigger.attributes['aria-expanded']",
    "assert.equal(trigger.attributes['aria-expanded'], 'true')",
    "assert.equal(trigger.attributes['aria-expanded'], 'false')",
    'const eventId = await fixtures.sendMessage(',
    "const positioner = await fixtures.account('reactions-positioner')",
    'await fixtures.invite(account, room.id, positioner)',
    'await fixtures.join(positioner, room.id)',
    'const sender = index === bodies.length - 1 ? account : positioner',
    'const MESSAGE = \'.scroll .msg[data-mid^="$"]\';',
    'const MESSAGE_AVATAR = `${MESSAGE} trn-avatar`;',
    "return { within: { selector: '.msg', text: body } };",
    'const binding = await client.eventIdentity(',
    'binding.matches === 1 && binding.exactEvent',
    'exactEventBinding: binding.exactEvent',
    "await client.scrollIntoViewIfNeeded(MESSAGE_AVATAR, '.scroll', avatar)",
    'avatarBinding.matches === 1 && avatarBinding.exactEvent',
    'await client.longPressCurrent(MESSAGE_AVATAR, avatar)',
    'await client.visible(\'[data-testid="sheet-react-more"]\')',
    'await client.tapCurrent(\'[data-testid="sheet-react-more"]\')',
    '\'[role="dialog"][aria-label="Pick a reaction"]\'',
    'const searchSelector = `${REACTION_DIALOG} .emoji-mart-search input`;',
    "await client.fill(searchSelector, 'rocket')",
    '.emoji-mart-category[aria-label="Search Results"] .emoji-mart-emoji[aria-label*="rocket" i]',
    'await client.tapCurrent(rocketSelector)',
    'const MESSAGE_REACTION_KEY = `${MESSAGE} .reaction .reaction__key`;',
    "const rocketKey = { exactText: '🚀', ...withinMessage(body) };",
    'await client.visible(MESSAGE_REACTION_KEY, rocketKey, 20_000)',
    'reactionBinding.matches === 1 && reactionBinding.exactEvent',
    'exactTarget: reactionBinding.exactEvent',
    'await fixtures.reactionEvents(account, roomId, targetEventId)',
    "event['type'] === 'm.reaction'",
    "relation['rel_type'] === 'm.annotation'",
    "relation['event_id'] === targetEventId",
    "relation['key'] === '🚀'",
    "event['sender'] === account.userId",
    'redactMaestroArtifacts(output, secrets, true)',
    'scanComposerReactionArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of requiredJourneyFragments)
    expect(journey).toContain(fragment);

  expect(fixtures).toContain('reactionEvents(');
  expect(fixtures).toContain(
    '/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.annotation/m.reaction',
  );
  expect(fixtures).toContain("stringField(response, 'event_id'");

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toContain('.hover()');
  expect(journey).not.toContain("getByTestId('react-more')");
  expect(journey).not.toContain('content: event');
}

describe('Android composer-reactions migration', () => {
  it('pins the exact predecessor and shared-helper sources', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '00f7444b5646cc445139b8911fb6c39f59abd3a0a42552a7fd1482ab9f25ed6a',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[22]).toContain('async function seedRoom');
    expect(predecessor[63]).toContain('async function openRoom');
    expect(predecessor[68]).toContain("getByTestId('composer-input')");
    expect(predecessor[76]).toContain(
      "test('opens and closes the composer’s own picker from its button'",
    );
    expect(predecessor[109]).toContain(
      "test('reacts with an emoji chosen from the full picker'",
    );

    const toggle = predecessor.slice(76, 108).join('\n');
    expect(toggle.match(/\bexpect\b/gu)).toHaveLength(4);
    expect(toggle.match(/await openRoom\(/gu)).toHaveLength(1);

    const reaction = predecessor.slice(109, 204).join('\n');
    const androidAssertionSites = [
      'await expect(row.first()).toBeVisible',
      'const sheet = await openMessageActionSheet',
      'await expect(dialog).toBeVisible',
      'await expect(picker).toBeVisible',
      'await expect(rocket.first()).toBeVisible',
      "page.locator('.scroll .reaction'",
    ];
    for (const site of androidAssertionSites) expect(reaction).toContain(site);
    expect(reaction.match(/await openRoom\(/gu)).toHaveLength(1);
    expect(reaction).toContain('if (isAndroidE2E)');
    expect(reaction).toContain('if (!isAndroidE2E)');
    expect(reaction).toContain('.toPass({ timeout: 30_000 })');
  });

  it('exports all 12 unique parity identities and exact source mapping', async () => {
    expect(
      contractPath,
      'composer-reactions-contract.mts must exist',
    ).toSatisfy(existsSync);
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.COMPOSER_REACTION_SOURCES).toEqual({
      helpers: `${predecessorSource}:22-72`,
      toggle: `${predecessorSource}:77-108`,
      reaction: `${predecessorSource}:110-204`,
      android: `${predecessorSource}:142-150`,
      desktopExcluded: `${predecessorSource}:152-177`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.composerReactionAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.composerReactionAssertions)).size,
    ).toBe(12);
    expect(contract.COMPOSER_REACTION_ASSERTION_RECORDS).toBe(12);
  });

  it('uses native product actions plus exact UI and Matrix relation proof', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'composer-reactions-journeys.mts must exist').not.toBe('');
    assertRuntimeContract(
      journey,
      read('e2e/android/account-workspace-fixtures.mts'),
    );
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when picker state, exact binding, native ownership, redaction, or cleanup weakens', () => {
    const journey = readIfPresent(journeyPath);
    const fixtures = read('e2e/android/account-workspace-fixtures.mts');
    expect(() => assertRuntimeContract(journey, fixtures)).not.toThrow();
    for (const [before, after] of [
      [
        "assert.equal(trigger.attributes['aria-expanded'], 'true')",
        'assert(trigger.visible)',
      ],
      [
        "assert.equal(trigger.attributes['aria-expanded'], 'false')",
        'assert(trigger.visible)',
      ],
      [
        'await client.longPressCurrent(MESSAGE_AVATAR, avatar)',
        'await client.tapCurrent(MESSAGE_AVATAR, avatar)',
      ],
      ['binding.matches === 1 && binding.exactEvent', 'binding.matches === 1'],
      [
        'avatarBinding.matches === 1 && avatarBinding.exactEvent',
        'avatarBinding.matches === 1',
      ],
      [
        'reactionBinding.matches === 1 && reactionBinding.exactEvent',
        'reactionBinding.matches === 1',
      ],
      [
        'await client.tapCurrent(\'[data-testid="sheet-react-more"]\')',
        'Promise.resolve()',
      ],
      ["await client.fill(searchSelector, 'rocket')", 'Promise.resolve()'],
      ['await client.tapCurrent(rocketSelector)', 'Promise.resolve()'],
      [
        "relation['event_id'] === targetEventId",
        "typeof relation['event_id'] === 'string'",
      ],
      ["relation['key'] === '🚀'", "typeof relation['key'] === 'string'"],
      ['redactMaestroArtifacts(output, secrets, true)', 'Promise.resolve()'],
      ['scanComposerReactionArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await client.close()', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ]) {
      expect(journey).toContain(before);
      expect(() =>
        assertRuntimeContract(journey.replaceAll(before, after), fixtures),
      ).toThrow();
    }
  });

  it('wires one-attempt Android execution, registry ownership, and started-only diagnostics', () => {
    const project = read('e2e/android/project.json');
    const registry = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const packageJson = read('package.json');
    const migration = read('e2e/android/MIGRATION.md');

    expect(project).toContain('"composer-reactions"');
    expect(project).toContain('--suite=android.composer-reactions');
    expect(project).toContain(
      '--entrypoint=e2e/android/composer-reactions-journeys.mts',
    );
    expect(registry).toContain("id: 'android.composer-reactions'");
    expect(commands).toContain("name: 'e2e:android:composer-reactions'");
    expect(packageJson).toContain('"e2e:android:composer-reactions"');
    expect(workflow).toContain('composer-reactions-started=true');
    expect(workflow).toContain('android-composer-reactions');
    expect(workflow).toContain('android.composer-reactions/**');
    expect(migration).toContain('## Composer reaction-picker journeys');
  });
});
