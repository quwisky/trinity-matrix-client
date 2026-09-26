import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const sourcePath =
  'e2e/browser/journeys/room-administration/space-leave.spec.mts';
const contractPath = resolve(root, 'e2e/android/space-leave-contract.mts');
const journeyPath = resolve(root, 'e2e/android/space-leave-journeys.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

// Literal issue #706 identities: this independent list detects omissions and substitutions.
const assertionIds = [
  'dialog.space-name',
  'dialog.account-name',
  'dialog.child-membership-copy',
  'cancel.memberships-retained',
  'cancel.space-pill-visible',
  'confirm.space-left',
  'confirm.child-membership-retained',
];

const forbiddenProductMutations = [
  /\.click\s*\(/,
  /\.focus\s*\(/,
  /\.dispatchEvent\s*\(/,
  /\.(?:requestSubmit|submit)\s*\(/,
  /(?:\b(?:document|window)\.)?\blocation(?:\.(?:href|pathname|search|hash))?\s*=(?!=)/,
  /\blocation\.(?:assign|replace|reload)\s*\(/,
  /\bhistory\.(?:back|forward|go|pushState|replaceState)\s*\(/,
  /\bwindow\.open\s*\(/,
  /client\.(?:focusFixture|navigate|reload)\s*\(/,
  /documentElement\.(?:style|classList|setAttribute|removeAttribute)/,
];

describe('Android Space leave migration', () => {
  it('pins the unchanged helper and single-definition predecessor', () => {
    const source = readFileSync(resolve(root, sourcePath));
    const lines = source.toString('utf8').split('\n');

    expect(createHash('sha256').update(source).digest('hex')).toBe(
      'a895c51a4a586f80d1399c31d1a3780d0c20c42534c926e9e53cf41f3fe8ed54',
    );
    expect(lines[16]).toBe('async function tokenFor(');
    expect(lines[52]).toBe('}');
    expect(lines[57]).toContain(
      "test('names the exact Account, cancels safely, and leaves child Room membership intact'",
    );
    expect(lines[124]).toBe('  });');
    expect(
      [...source.toString('utf8').matchAll(/^  test\('([^']+)'/gm)].map(
        (match) => match[1],
      ),
    ).toEqual([
      'names the exact Account, cancels safely, and leaves child Room membership intact',
    ]);
  });

  it('exports the exact source mappings and seven unique assertion identities', async () => {
    expect(
      existsSync(contractPath),
      'space-leave-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);

    expect(contract.SPACE_LEAVE_SOURCE).toEqual({
      helpers: `${sourcePath}:17-53`,
      definition: `${sourcePath}:58-125`,
    });
    expect(Object.values(contract.spaceLeaveAssertions)).toEqual(assertionIds);
    expect(new Set(Object.values(contract.spaceLeaveAssertions)).size).toBe(7);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?7,[\s\S]*?Exactly seven Space leave assertion identities are required/,
    );
  });

  it('implements one Pixel 5 native stage with every assertion identity', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey, 'space-leave-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('space-leave-contract.mts');
    expect(journey).toContain('SPACE_LEAVE_SOURCE.definition');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?1,[\s\S]*?Exactly one Space leave stage is required/,
    );
    for (const key of [
      'dialogSpaceName',
      'dialogAccountName',
      'dialogChildMembershipCopy',
      'cancelMembershipsRetained',
      'cancelSpacePillVisible',
      'confirmSpaceLeft',
      'confirmChildMembershipRetained',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds)
      expect(journey).not.toContain(`'${identity}'`);
  });

  it('seeds the Space graph and drives every product action through native input', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toContain("creation_content: { type: 'm.space' }");
    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('fixtures.setSpaceChild(');
    expect(journey).toContain('client.login(account)');
    expect(journey).toContain('client.tapCurrent(spacePillSelector)');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="space-actions-overflow"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="space-leave"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="alert-cancel"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="alert-confirm"]\')',
    );
    expect(journey).toContain('fixtures.joinedRoomIds(account)');
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('binds the dialog and membership identities to their exact outcomes', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.dialogSpaceName,[\s\S]*?\{ text: spaceName \},/,
    );
    expect(journey).toMatch(
      /assertions\.dialogAccountName,[\s\S]*?\{ text: account\.username \},/,
    );
    expect(journey).toMatch(
      /assertions\.dialogChildMembershipCopy,[\s\S]*?\{ text: 'You remain a member of its Rooms' \},/,
    );
    expect(journey).toMatch(
      /assertions\.cancelMembershipsRetained,[\s\S]*?roomIds\.includes\(space\.id\) && roomIds\.includes\(child\.id\)/,
    );
    expect(journey).toMatch(
      /assertions\.confirmSpaceLeft,[\s\S]*?\(roomIds\) => !roomIds\.includes\(space\.id\)/,
    );
    expect(journey).toMatch(
      /assertions\.confirmChildMembershipRetained,[\s\S]*?\(roomIds\) => roomIds\.includes\(child\.id\)/,
    );
  });

  it('retains invocation-owned lifecycle, evidence and secret redaction', () => {
    const journey = readIfPresent(journeyPath);

    for (const required of [
      'openMaestroDevice({',
      'device.install(',
      'client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE)',
      "status: 'running'",
      "stage.status = failures.length ? 'failed' : 'passed'",
      "join(output, 'journeys.json')",
      'redactMaestroArtifacts(output, secrets)',
      'device.close()',
      'client?.close()',
    ]) {
      expect(journey).toContain(required);
    }
    expect(journey.indexOf('await save();')).toBeLessThan(
      journey.indexOf('const device = await openMaestroDevice({'),
    );
    expect(journey.indexOf('await save();')).toBeLessThan(
      journey.indexOf('await device.install('),
    );
    expect(journey).not.toMatch(/password\s*:/);
    expect(journey).not.toMatch(/access[_-]?token\s*:/i);
  });
});
