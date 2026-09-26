import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const predecessorSource =
  'e2e/browser/journeys/conversations/composer-mentions.spec.mts';
const appSource = 'e2e/support/app.mts';
const accountSource = 'e2e/support/account.mts';
const contractPath = resolve(
  root,
  'e2e/android/composer-mentions-contract.mts',
);
const journeyPath = resolve(root, 'e2e/android/composer-mentions-journeys.mts');

const assertionIds = [
  'composer-mentions.touch.composer-ready',
  'composer-mentions.touch.autocomplete-visible',
  'composer-mentions.touch.member-visible',
  'composer-mentions.touch.inserted-value',
  'composer-mentions.touch.sent-mention',
  'composer-mentions.touch.mention-class',
  'composer-mentions.touch.font-weight',
  'composer-mentions.touch.background',
  'composer-mentions.keyboard.composer-ready',
  'composer-mentions.keyboard.autocomplete-visible',
  'composer-mentions.keyboard.inserted-value',
  'composer-mentions.keyboard.sent-link-visible',
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

function assertRuntimeContract(journey, client, fixtures) {
  const requiredJourneyFragments = [
    "id: 'touch-selection'",
    "id: 'keyboard-acceptance'",
    'expectedStages: 2',
    'expectedUniqueAssertions: 12',
    'expectedAssertionRecords: 12',
    'attempt: 1',
    'retries: 0',
    "tag === 'touch-selection' ? 'mentions-touch' : 'mentions-key'",
    'context.fixtures.account(`${accountTag}-reader`)',
    'context.fixtures.account(`${accountTag}-member`)',
    'await context.fixtures.setDisplayName(member, memberName)',
    'invite: [member.userId]',
    'await context.fixtures.join(member, room.id)',
    'await client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    'await context.client.focusCurrent(COMPOSER)',
    'await context.client.fillFocused(COMPOSER, prefix)',
    'elements[0].selectionStart === prefix.length',
    'elements[0].selectionEnd === prefix.length',
    'await client.hideKeyboard()',
    'await client.tapCurrentExposed(\'[data-testid="mention-autocomplete"] button\'',
    "await client.key('enter')",
    'await client.tapCurrent(\'[data-testid="composer-send"]\')',
    'assert.equal(composer.value, inserted)',
    'assert.equal(pill.attributes.href, expectedHref)',
    "pill.attributes.class.split(/\\s+/u).includes('mention')",
    'Number(pill.style.fontWeight) >= 600',
    'backgroundHasVisibleAlpha(pill.style.backgroundColor)',
    "message.attributes['data-mid']",
    "candidates[0].attributes['data-mid']?.startsWith('$')",
    'await fixtures.roomEvent(reader, room.id, eventId)',
    "content['m.mentions']",
    "mentions['user_ids']",
    'userIds.includes(member.userId)',
    'serverMentioned: true',
    'mentionCount: userIds.length',
    'redactMaestroArtifacts(output, secrets, true)',
    'scanComposerMentionArtifacts(output, secrets)',
    'await client.close()',
    'await device.clearApplicationData(APPLICATION_ID)',
    'device.close()',
  ];
  for (const fragment of requiredJourneyFragments)
    expect(journey).toContain(fragment);
  // Enter only accepts the highlighted suggestion: mobile Enter inserts a new line
  // in the composer (d3b27323), so both stages send through the Send button.
  expect(journey.split("await client.key('enter')")).toHaveLength(2);
  expect(
    journey.split('await client.tapCurrent(\'[data-testid="composer-send"]\')'),
  ).toHaveLength(3);

  expect(client).toContain("'class'");
  expect(client).toContain("'href'");
  expect(client).toContain("'data-mid'");
  expect(client).toContain('fontWeight:style.fontWeight');
  expect(client).toContain('backgroundColor:style.backgroundColor');
  const focusedFill = client.slice(
    client.indexOf('async fillFocused('),
    client.indexOf(
      '/** Replace a prefilled value',
      client.indexOf('async fillFocused('),
    ),
  );
  expect(focusedFill).toContain("await this.key('end')");
  expect(focusedFill).toContain("await this.key('space')");
  expect(focusedFill).toContain("await this.key('backspace')");
  expect(fixtures).toContain('roomEvent(');
  expect(fixtures).toContain(
    '`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`',
  );

  expect(journey).not.toMatch(/\bretries?\s*[:=]\s*[1-9]/u);
  expect(journey).not.toMatch(
    /evaluateNative\([\s\S]*?\.(?:click|focus|fill|submit|requestSubmit)\s*\(/u,
  );
  expect(journey).not.toContain('memberId: member.userId');
  expect(journey).not.toContain('displayName: memberName');
  expect(journey).not.toContain('content: event');
}

describe('Android composer-mentions migration', () => {
  it('pins the exact predecessor and shared-helper sources', () => {
    const predecessor = sourceLines(
      predecessorSource,
      '4fff4a23bbabe797ca87e8ed8b2fdda537e4af1adb4c5396cbb3d0feccd4eb39',
    );
    sourceLines(
      appSource,
      '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
    );
    sourceLines(
      accountSource,
      'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
    );

    expect(predecessor[20]).toContain('async function apiToken');
    expect(predecessor[42]).toContain('async function seedRoomWithMember');
    expect(predecessor[95]).toContain('async function openRoom');
    expect(predecessor[100]).toContain("getByTestId('composer-input')");
    expect(predecessor[108]).toContain(
      "test('autocompletes a member and sends a pinging mention'",
    );
    expect(predecessor[170]).toContain(
      "test('accepts a mention with the keyboard'",
    );
    expect(
      predecessor
        .slice(108, 169)
        .join('\n')
        .match(/\bexpect\b/gu),
    ).toHaveLength(7);
    expect(
      predecessor
        .slice(170, 197)
        .join('\n')
        .match(/\bexpect\b/gu),
    ).toHaveLength(3);
  });

  it('exports all 12 unique parity identities and exact source mapping', async () => {
    expect(contractPath, 'composer-mentions-contract.mts must exist').toSatisfy(
      existsSync,
    );
    if (!existsSync(contractPath)) return;
    const contract = await import(contractPath);
    expect(contract.COMPOSER_MENTION_SOURCES).toEqual({
      helpers: `${predecessorSource}:21-104`,
      touch: `${predecessorSource}:109-169`,
      keyboard: `${predecessorSource}:171-197`,
      app: appSource,
      account: accountSource,
    });
    expect(Object.values(contract.composerMentionAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.composerMentionAssertions)).size,
    ).toBe(12);
    expect(contract.COMPOSER_MENTION_ASSERTION_RECORDS).toBe(12);
  });

  it('uses native product actions plus independent UI and Matrix semantics', () => {
    const journey = readIfPresent(journeyPath);
    expect(journey, 'composer-mentions-journeys.mts must exist').not.toBe('');
    assertRuntimeContract(
      journey,
      read('e2e/android/account-workspace-client.mts'),
      read('e2e/android/account-workspace-fixtures.mts'),
    );
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('fails closed when identity, styling, server semantics, redaction, or cleanup weakens', () => {
    const journey = readIfPresent(journeyPath);
    const client = read('e2e/android/account-workspace-client.mts');
    const fixtures = read('e2e/android/account-workspace-fixtures.mts');
    expect(() =>
      assertRuntimeContract(journey, client, fixtures),
    ).not.toThrow();
    for (const [before, after] of [
      [
        'assert.equal(pill.attributes.href, expectedHref)',
        'assert(pill.visible)',
      ],
      [
        "pill.attributes.class.split(/\\s+/u).includes('mention')",
        'pill.visible',
      ],
      ['Number(pill.style.fontWeight) >= 600', 'pill.style.fontWeight !== ""'],
      [
        'backgroundHasVisibleAlpha(pill.style.backgroundColor)',
        'pill.style.backgroundColor !== ""',
      ],
      ['userIds.includes(member.userId)', 'userIds.length > 0'],
      [
        "candidates[0].attributes['data-mid']?.startsWith('$')",
        'candidates[0].visible',
      ],
      ['redactMaestroArtifacts(output, secrets, true)', 'Promise.resolve()'],
      ['scanComposerMentionArtifacts(output, secrets)', 'Promise.resolve()'],
      ['await client.hideKeyboard()', 'Promise.resolve()'],
      [
        'await client.tapCurrent(\'[data-testid="composer-send"]\')',
        "await client.key('enter')",
      ],
      [
        'await client.tapCurrentExposed(\'[data-testid="mention-autocomplete"] button\'',
        'await client.tapCurrent(\'[data-testid="mention-autocomplete"] button\'',
      ],
      ['await client.close()', 'Promise.resolve()'],
      [
        'await device.clearApplicationData(APPLICATION_ID)',
        'Promise.resolve()',
      ],
    ]) {
      expect(journey).toContain(before);
      expect(() =>
        assertRuntimeContract(
          journey.replaceAll(before, after),
          client,
          fixtures,
        ),
      ).toThrow();
    }

    expect(() =>
      assertRuntimeContract(
        journey,
        client.replace(
          "await this.key('backspace')",
          "await this.key('forwardDelete')",
        ),
        fixtures,
      ),
    ).toThrow();
  });

  it('wires one-attempt Android execution, registry ownership, and started-only diagnostics', () => {
    const project = read('e2e/android/project.json');
    const registry = read('e2e/registry/suites/runners.mts');
    const commands = read('e2e/registry/commands.mts');
    const workflow = read('.github/workflows/ci.yml');
    const packageJson = read('package.json');

    expect(project).toContain('"composer-mentions"');
    expect(project).toContain('--suite=android.composer-mentions');
    expect(project).toContain(
      '--entrypoint=e2e/android/composer-mentions-journeys.mts',
    );
    expect(registry).toContain("id: 'android.composer-mentions'");
    expect(commands).toContain("name: 'e2e:android:composer-mentions'");
    expect(packageJson).toContain('"e2e:android:composer-mentions"');
    expect(workflow).toContain('composer-mentions-started=true');
    expect(workflow).toContain('android-composer-mentions');
    expect(workflow).toContain('android.composer-mentions/**');
  });
});
