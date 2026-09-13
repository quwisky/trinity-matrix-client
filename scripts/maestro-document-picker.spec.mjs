import { describe, expect, it, vi } from 'vitest';
import { pickAndroidDocument } from '../e2e/android/maestro-document-picker.mts';

const workspaceRoot = '/workspace';
const flowPath = `${workspaceRoot}/e2e/android/flows/accounts-document-pick.yaml`;

function device({ flowFailure } = {}) {
  const calls = [];
  return {
    calls,
    device: {
      adb: vi.fn(async (...args) => {
        calls.push(['adb', ...args]);
        return '';
      }),
      runFlow: vi.fn(async (file, variables) => {
        calls.push(['flow', file, variables]);
        if (flowFailure) throw flowFailure;
      }),
    },
  };
}

describe('Android document picker staging', () => {
  it('stages, selects, and removes an Android document in order', async () => {
    const fixture = device();

    await pickAndroidDocument(
      fixture.device,
      workspaceRoot,
      '/tmp/photo.png',
      'space-photo.png',
    );

    expect(fixture.calls).toEqual([
      ['adb', 'push', '/tmp/photo.png', '/sdcard/Download/space-photo.png'],
      [
        'flow',
        flowPath,
        { APP_ID: 'eu.qwky.trinity', FILE_NAME: 'space-photo.png' },
      ],
      ['adb', 'shell', 'rm', '-f', '/sdcard/Download/space-photo.png'],
    ]);
  });

  it.each(['nested/photo.png', 'nested\\photo.png'])(
    'rejects a document name with a path separator: %s',
    async (remoteName) => {
      const fixture = device();

      await expect(
        pickAndroidDocument(
          fixture.device,
          workspaceRoot,
          '/tmp/photo.png',
          remoteName,
        ),
      ).rejects.toThrow('path separator');
      expect(fixture.calls).toEqual([]);
    },
  );

  it('removes the staged document when the selection flow fails', async () => {
    const failure = new Error('DocumentsUI flow failed');
    const fixture = device({ flowFailure: failure });

    await expect(
      pickAndroidDocument(
        fixture.device,
        workspaceRoot,
        '/tmp/photo.png',
        'space-photo.png',
      ),
    ).rejects.toBe(failure);

    expect(fixture.calls).toEqual([
      ['adb', 'push', '/tmp/photo.png', '/sdcard/Download/space-photo.png'],
      [
        'flow',
        flowPath,
        { APP_ID: 'eu.qwky.trinity', FILE_NAME: 'space-photo.png' },
      ],
      ['adb', 'shell', 'rm', '-f', '/sdcard/Download/space-photo.png'],
    ]);
  });
});
