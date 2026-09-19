import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const reportSource =
  'e2e/browser/journeys/room-administration/report-message.spec.mts';
const redactSource =
  'e2e/browser/journeys/room-administration/redact-others.spec.mts';
const contractPath = resolve(
  root,
  'e2e/android/message-moderation-contract.mts',
);
const journeyPath = resolve(
  root,
  'e2e/android/message-moderation-journeys.mts',
);
const clientPath = resolve(root, 'e2e/android/account-workspace-client.mts');
const readIfPresent = (path) =>
  existsSync(path) ? readFileSync(path, 'utf8') : '';

const assertionIds = [
  'report.timeline-visible',
  'report.success-toast-visible',
  'redact.timeline-visible',
  'redact.deleted-marker-visible',
  'redact.original-body-absent',
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
  /Page\.navigate/,
];

describe('Android message moderation migration', () => {
  it('pins both unchanged helpers and single-definition predecessors', () => {
    const report = readFileSync(resolve(root, reportSource));
    const redact = readFileSync(resolve(root, redactSource));
    const reportLines = report.toString('utf8').split('\n');
    const redactLines = redact.toString('utf8').split('\n');

    expect(createHash('sha256').update(report).digest('hex')).toBe(
      '3f8e9051936b66e5b6ab1112d52f29f95826866bc4277e7ba6d5bdd9ca312b7c',
    );
    expect(createHash('sha256').update(redact).digest('hex')).toBe(
      'b7bb891ccdde3bb829044b6378247971555be539a6a8cd190f7ace323fa78b57',
    );
    expect(reportLines[18]).toContain('async function openRoom');
    expect(reportLines[24]).toBe('}');
    expect(reportLines[29]).toContain(
      "test('reports a message to the server admins'",
    );
    expect(reportLines[79]).toBe('  });');
    expect(redactLines[56]).toContain('async function openRoom');
    expect(redactLines[62]).toBe('}');
    expect(redactLines[67]).toContain(
      "test('a room admin can delete another member’s message'",
    );
    expect(redactLines[142]).toBe('  });');
  });

  it('exports exact source mappings and five unique assertion identities', async () => {
    expect(
      existsSync(contractPath),
      'message-moderation-contract.mts must exist',
    ).toBe(true);
    const contract = await import(contractPath);

    expect(contract.MESSAGE_MODERATION_SOURCES).toEqual({
      report: {
        helper: `${reportSource}:19-25`,
        definition: `${reportSource}:30-80`,
      },
      redact: {
        helper: `${redactSource}:57-63`,
        definition: `${redactSource}:68-143`,
      },
    });
    expect(Object.values(contract.messageModerationAssertions)).toEqual(
      assertionIds,
    );
    expect(
      new Set(Object.values(contract.messageModerationAssertions)).size,
    ).toBe(5);
    expect(readIfPresent(contractPath)).toMatch(
      /assert\.equal\([\s\S]*?5,[\s\S]*?Exactly five message moderation assertion identities are required/,
    );
  });

  it('adds one measured 750 ms near-static Maestro long-press primitive', () => {
    const client = readFileSync(clientPath, 'utf8');

    expect(client).toMatch(
      /async longPressCurrent\(\s*selector: string,\s*filter: AccountElementFilter = \{\},\s*\): Promise<void>/,
    );
    expect(client).toContain('const LONG_PRESS_DURATION_MS = 750;');
    expect(client).toContain('const LONG_PRESS_DRIFT_PX = 2;');
    expect(client).toContain('const LONG_PRESS_THRESHOLD_MS = 500;');
    expect(client).toMatch(
      /- swipe:\\n\s+start: "\$\{point\.x\},\$\{point\.y\}"\\n\s+end: "\$\{point\.x \+ LONG_PRESS_DRIFT_PX\},\$\{point\.y\}"\\n\s+duration: \$\{LONG_PRESS_DURATION_MS\}/,
    );
    expect(client).toMatch(
      /types=\['pointerdown','pointermove','pointerup','pointercancel'\]/,
    );
    expect(client).toMatch(
      /event\?\.type === 'pointerup' \|\|\s*event\?\.type === 'pointercancel'/,
    );
    expect(client).toContain('private async longPressTarget(');
    expect(client).toContain(
      "'a,button,img,video,audio,input,textarea,select'",
    );
    expect(client).toContain("getComputedStyle(node).userSelect==='none'");
    expect(client).toContain("if(userSelect!=='none')continue");
    expect(client).toContain('selectionSafe:true');
    expect(client).toContain(
      'non-selectable native long-press point inside ${selector}',
    );
    expect(client).toMatch(
      /Math\.max\(\.\.\.samePointerEvents\.map\(\(event\) => event\.timeStamp\)\)/,
    );
    expect(client).toMatch(
      /assert\(\s*durationMs >= LONG_PRESS_THRESHOLD_MS,[\s\S]*?held for at least/,
    );
    expect(client).not.toContain('longPressOn:');
  });

  it('implements two Pixel 5 stages with every assertion identity', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey, 'message-moderation-journeys.mts must exist').not.toBe('');
    expect(journey).toContain('message-moderation-contract.mts');
    expect(journey).toContain('MESSAGE_MODERATION_SOURCES.report.definition');
    expect(journey).toContain('MESSAGE_MODERATION_SOURCES.redact.definition');
    expect(journey).toContain('PIXEL_5_ACCOUNT_PROFILE');
    expect(journey).toMatch(
      /assert\.equal\([\s\S]*?cases\.length,[\s\S]*?2,[\s\S]*?Exactly two message moderation stages are required/,
    );
    for (const key of [
      'reportTimelineVisible',
      'reportSuccessToastVisible',
      'redactTimelineVisible',
      'redactDeletedMarkerVisible',
      'redactOriginalBodyAbsent',
    ]) {
      expect(journey).toMatch(new RegExp(`assertions\\.${key}\\b`));
    }
    for (const identity of assertionIds) {
      expect(journey).not.toContain(`'${identity}'`);
    }
  });

  it('seeds reporting and redaction fixtures and drives every product action natively', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toContain("preset: 'private_chat'");
    expect(journey).toContain('invite: [member.userId]');
    expect(journey).toContain('fixtures.join(member, room.id)');
    expect(journey).toContain('fixtures.sendMessage(');
    expect(journey).toContain('client.login(');
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="rail-rooms"]\')',
    );
    expect(journey).toContain("client.tapCurrent('.channel'");
    expect(journey).toContain(
      "client.longPressCurrent('.scroll .msg[data-mid]'",
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="sheet-report"]\')',
    );
    expect(journey).toContain(
      'client.tapCurrent(\'[data-testid="sheet-delete"]\')',
    );
    expect(journey).toMatch(
      /client\.scrollIntoViewIfNeeded\(\s*'\[data-testid="sheet-report"\]',\s*'\[data-testid="action-sheet-surface"\] \.overflow-y-auto',\s*\)/,
    );
    expect(journey).toMatch(
      /client\.scrollIntoViewIfNeeded\(\s*'\[data-testid="sheet-delete"\]',\s*'\[data-testid="action-sheet-surface"\] \.overflow-y-auto',\s*\)/,
    );
    expect(
      journey.match(/client\.tapCurrent\('\[data-testid="alert-confirm"\]'\)/g),
    ).toHaveLength(2);
    for (const mutation of forbiddenProductMutations) {
      expect(journey).not.toMatch(mutation);
    }
  });

  it('binds reporting identities to timeline readiness and the exact toast', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.reportTimelineVisible,\s*'\.scroll',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toContain(
      "document.querySelectorAll('[data-sonner-toast]')",
    );
    expect(journey).toContain('new MutationObserver(sample)');
    expect(journey).toMatch(
      /exactFeedbackDuringNativeAction\(\s*client,\s*assertions\.reportSuccessToastVisible,\s*'Reported to the server admins\.',\s*\(\) =>\s*client\.tapCurrent\('\[data-testid="alert-confirm"\]'\),\s*\)/,
    );
  });

  it('binds redaction identities to timeline, deleted marker, and body absence', () => {
    const journey = readIfPresent(journeyPath);

    expect(journey).toMatch(
      /assertions\.redactTimelineVisible,\s*'\.scroll',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible/,
    );
    expect(journey).toMatch(
      /assertions\.redactDeletedMarkerVisible,\s*'\.scroll \.msg',\s*\(elements\) =>\s*elements\.length === 1 && elements\[0\]!\.visible,\s*\{ text: '\(message deleted\)' \}/,
    );
    expect(journey).toMatch(
      /assertions\.redactOriginalBodyAbsent,\s*'\.scroll \.msg',\s*\(elements\) =>\s*elements\.length === 0,\s*\{ text: memberBody \}/,
    );
  });

  it('retains invocation-owned lifecycle, evidence, and secret redaction', () => {
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
