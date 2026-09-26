import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redactMaestroArtifacts } from '../e2e/android/maestro-session.mts';

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const account = {
  username: 'sheet-sensitive-user',
  userId: '@sheet-sensitive-user:test',
  password: 'sensitive "password"\\value',
};
const roomName = 'sensitive room name';
const history = {
  targetEventId: '$sensitive-target-event',
  oldestFillerEventId: '$sensitive-oldest-event',
};

async function artifactFixture() {
  const helpers =
    await import('../e2e/android/message-action-sheet-artifacts.mts');
  const output = await mkdtemp(join(tmpdir(), 'trinity-sheet-artifacts-'));
  directories.push(output);
  const secrets = helpers.messageActionSheetSecrets(
    'reply',
    account,
    roomName,
    history,
  );
  return { ...helpers, output, secrets };
}

describe('message action sheet artifact privacy', () => {
  it('redacts every registered identity with the actual shared redactor before scanning', async () => {
    const { output, secrets, scanMessageActionSheetArtifacts } =
      await artifactFixture();
    expect(Object.values(secrets)).toEqual([
      account.username,
      account.userId,
      account.password,
      roomName,
      history.targetEventId,
      history.oldestFillerEventId,
    ]);
    await writeFile(
      join(output, 'receipt.json'),
      JSON.stringify({ values: Object.values(secrets) }),
    );
    await writeFile(
      join(output, 'native.log'),
      Object.values(secrets).join('\n'),
    );
    await writeFile(
      join(output, 'capture.png'),
      Buffer.from([137, 80, 78, 71]),
    );
    await expect(
      scanMessageActionSheetArtifacts(output, secrets),
    ).rejects.toThrow();
    await redactMaestroArtifacts(output, secrets, true);
    await expect(
      scanMessageActionSheetArtifacts(output, secrets),
    ).resolves.toBeUndefined();
    for (const file of ['receipt.json', 'native.log']) {
      const text = await readFile(join(output, file), 'utf8');
      for (const secret of Object.values(secrets)) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
      }
    }
    await expect(access(join(output, 'capture.png'))).rejects.toThrow();
  });

  it('omits the absent oldest event without losing any other identity', async () => {
    const { messageActionSheetSecrets } = await artifactFixture();
    const secrets = messageActionSheetSecrets('reply', account, roomName, {
      ...history,
      oldestFillerEventId: null,
    });
    expect(Object.values(secrets)).toHaveLength(5);
    expect(Object.values(secrets)).not.toContain(null);
  });

  it.each([
    ['plain credential', () => account.password, 'receipt.txt'],
    [
      'JSON-escaped credential',
      () => JSON.stringify(account.password),
      'receipt.json',
    ],
    ['bearer', () => 'Bearer synthetic-auth-value', 'native.log'],
    ['Matrix token', () => 'syt_synthetic-token', 'native.log'],
    [
      'native storage',
      () => 'pluginId: Preferences methodData: {"account":"secret"}',
      'native.log',
    ],
    ['raster', () => 'not even a valid image', 'capture.gif'],
  ])('rejects retained %s', async (_name, contents, filename) => {
    const { output, secrets, scanMessageActionSheetArtifacts } =
      await artifactFixture();
    await writeFile(join(output, filename), contents());
    await expect(
      scanMessageActionSheetArtifacts(output, secrets),
    ).rejects.toThrow();
  });
});
