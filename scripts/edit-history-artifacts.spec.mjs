import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const helpers = await import('../e2e/android/edit-history-artifacts.mts');
  const output = await mkdtemp(
    join(tmpdir(), 'trinity-edit-history-artifacts-'),
  );
  directories.push(output);
  const secrets = helpers.editHistorySecrets(
    'revision-lifecycle',
    {
      username: 'sensitive-edit-user',
      userId: '@sensitive-edit-user:test',
      password: 'secret "password"\\value',
    },
    'sensitive edit room',
    {
      roomId: '!sensitive-room:test',
      roomName: 'sensitive edit room',
      plain: {
        originalId: '$sensitive-original',
        editIds: ['$sensitive-edit-one', '$sensitive-edit-two'],
      },
      formatted: {
        originalId: '$sensitive-formatted',
        editId: '$sensitive-format-edit',
      },
      doomed: {
        originalId: '$sensitive-doomed',
        editId: '$sensitive-doomed-edit',
      },
    },
  );
  return { ...helpers, output, secrets };
}

describe('Android edit-history artifact privacy', () => {
  it('registers both Pixel edit-event IDs before any diagnostic publication', async () => {
    const { editHistorySecrets } = await fixture();
    const values = Object.values(
      editHistorySecrets(
        'pixel5-large-text',
        {
          username: 'sensitive-edit-user',
          userId: '@sensitive-edit-user:test',
          password: 'secret',
        },
        'Pixel room',
        {
          roomId: '!pixel-room:test',
          roomName: 'Pixel room',
          originalId: '$pixel-original',
          editIds: ['$pixel-edit-one', '$pixel-edit-two'],
          versions: [],
        },
      ),
    );
    expect(values).toContain('$pixel-edit-one');
    expect(values).toContain('$pixel-edit-two');
  });

  it('scrubs registered identifiers, JSON-escaped secrets, and rasters before scanning', async () => {
    const {
      output,
      secrets,
      scrubEditHistoryArtifacts,
      scanEditHistoryArtifacts,
    } = await fixture();
    expect(Object.values(secrets)).toContain('$sensitive-edit-two');
    expect(Object.values(secrets)).toContain('$sensitive-doomed-edit');
    const raw = Object.values(secrets).join('\n');
    await writeFile(join(output, 'native.log'), raw);
    await writeFile(join(output, 'receipt.json'), JSON.stringify({ raw }));
    await writeFile(
      join(output, 'early-failure.png'),
      Buffer.from([0x89, 0x50]),
    );
    await writeFile(join(output, 'early-failure.gif'), Buffer.from('unsafe'));
    await expect(scanEditHistoryArtifacts(output, secrets)).rejects.toThrow();
    await scrubEditHistoryArtifacts(output, secrets);
    await expect(
      scanEditHistoryArtifacts(output, secrets),
    ).resolves.toBeUndefined();
    for (const name of ['native.log', 'receipt.json']) {
      const content = await readFile(join(output, name), 'utf8');
      for (const value of Object.values(secrets)) {
        expect(content).not.toContain(value);
        expect(content).not.toContain(JSON.stringify(value).slice(1, -1));
      }
    }
    await expect(access(join(output, 'early-failure.png'))).rejects.toThrow();
    await expect(access(join(output, 'early-failure.gif'))).rejects.toThrow();
  });

  it.each([
    ['plain password', 'secret "password"\\value', 'secret.txt'],
    [
      'escaped password',
      JSON.stringify('secret "password"\\value'),
      'secret.json',
    ],
    ['unregistered access token', 'syt_synthetic-token', 'token.log'],
    ['bearer header', 'Authorization: Bearer synthetic-token', 'bearer.log'],
    [
      'Preferences payload',
      'pluginId: Preferences methodData: {"secret":1}',
      'storage.log',
    ],
    [
      'SecureStorage payload',
      'pluginId: SecureStorage methodData: {"secret":1}',
      'secure.log',
    ],
    ['raster without collected secrets', 'unsafe', 'capture.webp'],
  ])('rejects an unsafe %s', async (_label, content, name) => {
    const { output, secrets, scanEditHistoryArtifacts } = await fixture();
    await writeFile(join(output, name), content);
    await expect(
      scanEditHistoryArtifacts(output, name.endsWith('.webp') ? {} : secrets),
    ).rejects.toThrow();
  });

  it('removes rasters even before secrets exist and rejects a failed scrub', async () => {
    const { output, scrubEditHistoryArtifacts, scanEditHistoryArtifacts } =
      await fixture();
    await writeFile(join(output, 'early.png'), Buffer.from([0x89, 0x50]));
    await scrubEditHistoryArtifacts(output, {});
    await expect(access(join(output, 'early.png'))).rejects.toThrow();
    await symlink('missing-target', join(output, 'broken.log'));
    await expect(scrubEditHistoryArtifacts(output, {})).rejects.toThrow();
    await expect(scanEditHistoryArtifacts(output, {})).rejects.toThrow();
    await expect(access(join(output, 'publication-safe'))).rejects.toThrow();
  });

  it('accepts a clean textual report', async () => {
    const { output, scanEditHistoryArtifacts } = await fixture();
    await writeFile(
      join(output, 'journeys.json'),
      JSON.stringify({
        expectedStages: 2,
        expectedAssertionRecords: 62,
        status: 'passed',
      }),
    );
    await expect(scanEditHistoryArtifacts(output, {})).resolves.toBeUndefined();
  });
});
