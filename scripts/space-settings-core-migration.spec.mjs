import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts';
const androidPath = (name) => resolve(root, `e2e/android/${name}.mts`);
const readAndroid = (name) => {
  const path = androidPath(name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const loadAndroid = async (name) => {
  const path = androidPath(name);
  expect(existsSync(path), `${name}.mts must exist`).toBe(true);
  return import(path);
};

// Literal issue #701 identities: this independent list detects omissions and substitutions.
const assertionIds = [
  'admin.conversation-visible',
  'admin.conversation-heading',
  'admin.name-field-visible',
  'admin.directory-visible',
  'admin.account-owner',
  'admin.heading-focused',
  'admin.desktop-width',
  'admin.compact-directory-hidden',
  'admin.compact-back-visible',
  'admin.desktop-directory-restored',
  'admin.scaled-cancel-visible',
  'admin.scaled-actions-hidden',
  'admin.photo-feedback',
  'admin.photo-persisted',
  'admin.general-feedback',
  'admin.name-persisted',
  'admin.topic-persisted',
  'admin.join-rule-persisted',
  'admin.dialog-closed',
  'admin.conversation-retained',
  'admin.heading-retained',
  'seed.name',
  'seed.topic',
  'seed.join-rule',
  'contents.panel-visible',
  'contents.linked-name',
  'contents.linked-type-room',
  'contents.scaled-create-space-visible',
  'contents.scaled-no-overflow',
  'contents.candidate-room-linked',
  'contents.candidate-space-linked',
  'contents.created-space-linked',
  'contents.created-space-type',
  'contents.recovery-visible',
  'contents.recovery-name',
  'contents.recovered-id',
  'contents.create-first-count',
  'contents.recovery-dismissed',
  'contents.recovered-linked',
  'contents.create-retry-count',
  'contents.no-child-parent-governance',
  'contents.remove-room-name',
  'contents.remove-room-parent-name',
  'contents.remove-room-not-deleted',
  'contents.cancel-keeps-room-linked',
  'contents.room-unlinked',
  'contents.room-membership-retained',
  'contents.remove-space-name',
  'contents.remove-space-parent-name',
  'contents.space-unlinked',
  'contents.space-membership-retained',
  'contents.demote-write',
  'contents.actions-hidden',
  'contents.candidate-space-visible',
  'contents.unlink-hidden',
  'contents.suggest-hidden',
  'contents.move-up-hidden',
  'readonly.name',
  'readonly.no-topic',
  'readonly.name-paragraph',
  'readonly.topic-paragraph',
  'readonly.general-actions-hidden',
  'readonly.join-rule-disabled',
  'readonly.permission-explanation',
  'readonly.access-policy',
  'readonly.access-actions-hidden',
  'readonly.child-visible',
  'readonly.contents-actions-hidden',
  'readonly.unlink-hidden',
  'readonly.contents-explanation',
  'permission.topic-editable',
  'permission.actions-visible',
  'permission.topic-readonly',
  'permission.draft-retained',
  'permission.draft-explanation',
  'permission.discard-visible',
  'permission.save-disabled',
  'address.panel-visible',
  'address.dialog-retained',
  'address.visible',
  'address.resolves',
  'members.dialog-visible',
  'members.heading',
  'members.owner-row',
  'members.admin-row',
];

const stages = [
  [
    'admin',
    'adminSource',
    '186-360',
    'space-settings-core-admin-journeys',
    'spaceSettingsCoreAdminCases',
  ],
  [
    'seed',
    'seedSource',
    '362-411',
    'space-settings-core-admin-journeys',
    'spaceSettingsCoreAdminCases',
  ],
  [
    'contents',
    'contentsSource',
    '413-670',
    'space-settings-core-contents-journey',
    'spaceSettingsCoreContentsCase',
  ],
  [
    'readonly',
    'readonlySource',
    '672-775',
    'space-settings-core-permissions-journeys',
    'spaceSettingsCorePermissionCases',
  ],
  [
    'permission',
    'permissionSource',
    '777-851',
    'space-settings-core-permissions-journeys',
    'spaceSettingsCorePermissionCases',
  ],
  [
    'address',
    'addressSource',
    '853-904',
    'space-settings-core-permissions-journeys',
    'spaceSettingsCorePermissionCases',
  ],
  [
    'members',
    'membersSource',
    '906-1000',
    'space-settings-core-permissions-journeys',
    'spaceSettingsCorePermissionCases',
  ],
];

const mutations = [
  /\.click\s*\(/,
  /\.focus\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.(?:requestSubmit|submit)\s*\(/,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/,
  /\blocation\.(?:assign|replace|reload)\s*\(/,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/,
  /\bwindow\.open\s*\(/,
  /client\.(?:focusFixture|navigate|reload)\s*\(/,
];

describe('Android core Space Settings migration', () => {
  it('keeps the native Topic payload independent of generated suite tokens', () => {
    const source = readAndroid('space-settings-core-admin-journeys');
    expect(source.match(/const newTopic = (.+);/)?.[1]).toBe(
      "'Where the team works'",
    );
    expect(source).toContain(
      'await client.fill(\'[data-testid="space-settings-topic"]\', newTopic)',
    );
    expect(source).toContain("(value) => value?.['topic'] === newTopic");
  });

  it('pins the unchanged seven-definition predecessor and helper span', () => {
    const source = readFileSync(resolve(root, sourcePath));
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      '662f0fc7c62ba206aa1bd344c1d9ecf913162424c486b97059d252ff7ea30a3a',
    );
    const titles = [
      'an admin renames a space, sets its topic and publishes it',
      'the dialog seeds from the space’s current values',
      'an admin adds, creates, recovers and unlinks exact Space contents',
      'a member without permission sees plain General values without actions',
      'keeps a dirty General edit visible and readonly after permission is lost',
      'an admin publishes an address for the space',
      'Space settings names the creator Owner and an equal-power member Admin',
    ];
    expect(
      [...source.toString().matchAll(/^  test\('([^']+)'/gm)].map(
        (match) => match[1],
      ),
    ).toEqual(titles);
    const lines = source.toString().split('\n');
    for (const [index, stage] of stages.entries()) {
      const [start, end] = stage[2].split('-').map(Number);
      expect(lines[start - 1]).toContain(`test('${titles[index]}'`);
      expect(lines[end - 1]).toBe('  });');
    }
    expect(lines[28]).toBe('async function apiLogin(');
    expect(lines[180]).toBe('}');
  });

  it('exports exactly seven source mappings and all 85 unique literal identities', async () => {
    const contract = await loadAndroid('space-settings-core-contract');
    expect(new Set(assertionIds).size).toBe(85);
    expect(Object.values(contract.spaceSettingsCoreAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.spaceSettingsCoreAssertions)).size,
    ).toBe(85);
    for (const [, source, span] of stages) {
      expect(contract[source]).toBe(`${sourcePath}:${span}`);
    }
    expect(readAndroid('space-settings-core-contract')).toContain(
      'space-settings.spec.mts:29-181',
    );
    expect(readAndroid('space-settings-core-contract')).toMatch(
      /assert\.equal\([\s\S]*?85,/,
    );
  });

  for (const [prefix, sourceName, span, moduleName, exportName] of stages) {
    it(`requires the ${prefix} journey stage and its exact assertion uses`, async () => {
      const text = readAndroid(moduleName);
      expect(text, `${moduleName}.mts must implement ${prefix}`).not.toBe('');
      expect(text).toContain('space-settings-core-contract.mts');
      expect(text).toContain('space-settings-core-observations.mts');
      const contract = await loadAndroid('space-settings-core-contract');
      const journey = await loadAndroid(moduleName);
      const cases = Array.isArray(journey[exportName])
        ? journey[exportName]
        : [journey[exportName]];
      expect(cases).toHaveLength(
        prefix === 'admin' || prefix === 'seed'
          ? 2
          : prefix === 'contents'
            ? 1
            : 4,
      );
      const matching = cases.filter(
        (entry) => entry?.source === `${sourcePath}:${span}`,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0].run).toBeTypeOf('function');
      expect(text).toMatch(new RegExp(`source:\\s*${sourceName}\\b`));
      for (const [key, identity] of Object.entries(
        contract.spaceSettingsCoreAssertions,
      )) {
        if (identity.startsWith(`${prefix}.`)) {
          expect(text).toMatch(
            new RegExp(
              `(?:assertions|spaceSettingsCoreAssertions)\\.${key}\\b`,
            ),
          );
          expect(text).not.toContain(`'${identity}'`);
        }
      }
      for (const mutation of mutations) expect(text).not.toMatch(mutation);
      expect(text).not.toMatch(
        /documentElement\.(?:style|classList|setAttribute|removeAttribute)/,
      );
      if (prefix === 'admin') {
        for (const required of [
          'client.tapCurrent(',
          'client.fill(',
          'pickAndroidDocument(',
          'withSpaceSettingsVisualFixture(',
          'fixtures.roomState(',
          'space-settings-desktop-general-light',
          'space-settings-desktop-general-dark-amethyst',
          'space-access-admin',
        ])
          expect(text).toContain(required);
        expect(text).toMatch(/client\.resize\(700,\s*800\)/);
        expect(text).toContain('125%');
      }
      if (prefix === 'seed') {
        expect(text).toContain('fixtures.setRoomState(');
        expect(text).toContain("join_rule: 'public'");
      }
      if (prefix === 'contents') {
        for (const required of [
          "client.key('space')",
          'client.tapCurrent(',
          'client.fill(',
          'installFirstMatrixHttpFailure(',
          "kind: 'room-state'",
          "eventType: 'm.space.child'",
          'roomId:',
          'stateKey:',
          'createRoomAttempts',
          'fixtures.spaceChildIds(',
          'fixtures.spaceChild(',
          'fixtures.roomState(',
          "'m.space.parent'",
          'fixtures.roomMembership(',
          'fixtures.setRoomPower(',
          'withSpaceSettingsVisualFixture(',
          'space-contents-desktop',
          'space-contents-desktop-dark-amethyst',
        ])
          expect(text).toContain(required);
      }
      if (prefix === 'readonly')
        expect(text).toContain('space-access-member-read-only');
      if (prefix === 'permission') {
        expect(text).toContain('fixtures.setRoomPower(');
        expect(text).toContain('client.fill(');
      }
      if (prefix === 'address') {
        expect(text).toContain("client.key('enter')");
        expect(text).toContain('fixtures.resolveRoomAlias(');
      }
      if (prefix === 'members') expect(text).toContain('open-space-members');
    });
  }

  it('keeps the shared observation/navigation module read-only apart from native input', () => {
    const text = readAndroid('space-settings-core-observations');
    expect(text).toContain('AccountWorkspaceClient');
    expect(text).toContain('waitForNativeShellState(');
    expect(text).toContain('client.tapCurrent(');
    for (const mutation of mutations) expect(text).not.toMatch(mutation);
    expect(text).not.toContain('documentElement.style');
  });

  it('keeps nested suite timeouts above the measured hosted runtime', () => {
    const entrypoint = readAndroid('space-settings-core-journeys');
    const project = JSON.parse(
      readFileSync(resolve(root, 'e2e/android/project.json'), 'utf8'),
    );
    const command = project.targets['space-settings-core'].options.command;

    expect(entrypoint).toContain('{ timeout: 2_400_000 }');
    expect(command).toContain('--timeout-ms=2520000');
  });
});

function observationClient(read, recordFailure) {
  const records = [];
  return {
    records,
    signal: new AbortController().signal,
    elements: read,
    webview: {
      diagnostics: { send: async () => ({ result: { value: await read() } }) },
    },
    record: async (identity, value) => {
      if (recordFailure) throw recordFailure;
      records.push({ identity, value });
    },
  };
}

describe('Space Settings assertion evidence', () => {
  for (const kind of ['elements', 'expression', 'server']) {
    const invoke = (observations, client, read, accepts, timeoutMs) => {
      if (kind === 'elements')
        return observations.observedElements(
          client,
          'seed.name',
          '#name',
          accepts,
          {},
          timeoutMs,
        );
      if (kind === 'expression')
        return observations.observedExpression(
          client,
          'seed.name',
          'document.title',
          accepts,
          timeoutMs,
        );
      return observations.observedServerValue(
        client,
        'seed.name',
        read,
        accepts,
        timeoutMs,
      );
    };

    it(`records successful ${kind} evidence`, async () => {
      const observations = await loadAndroid(
        'space-settings-core-observations',
      );
      const value =
        kind === 'elements' ? [{ text: 'Seeded', visible: true }] : 'Seeded';
      const read = async () => value;
      const client = observationClient(read);
      expect(
        await invoke(
          observations,
          client,
          read,
          (actual) => actual === value,
          100,
        ),
      ).toBe(value);
      expect(client.records).toEqual([
        {
          identity: 'seed.name',
          value: { assertion: 'seed.name', observation: value },
        },
      ]);
    });

    it(`retains the last rejected ${kind} observation on timeout`, async () => {
      const observations = await loadAndroid(
        'space-settings-core-observations',
      );
      const value = kind === 'elements' ? [] : 'Wrong name';
      const read = async () => value;
      const client = observationClient(read);
      await expect(
        invoke(observations, client, read, () => false, 1),
      ).rejects.toThrow('seed.name');
      expect(client.records).toEqual([
        {
          identity: 'seed.name',
          value: {
            assertion: 'seed.name',
            observation: value,
            error: expect.stringContaining('Timed out'),
          },
        },
      ]);
    });

    it(`preserves ${kind} read and diagnostic failures without replaying a read`, async () => {
      const observations = await loadAndroid(
        'space-settings-core-observations',
      );
      const failure = new Error('read failed');
      const recordFailure = new Error('evidence disk full');
      let reads = 0;
      const read = async () => {
        reads++;
        throw failure;
      };
      const client = observationClient(read, recordFailure);
      const error = await invoke(
        observations,
        client,
        read,
        () => true,
        100,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toEqual([failure, recordFailure]);
      expect(reads).toBe(1);
    });
  }
});
