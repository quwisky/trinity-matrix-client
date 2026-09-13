import { describe, expect, it, vi } from 'vitest';
import { pickAndroidDocument } from '../e2e/android/maestro-document-picker.mts';
import * as picker from '../e2e/android/maestro-document-picker.mts';

const workspaceRoot = '/workspace';
const flowPath = `${workspaceRoot}/e2e/android/flows/accounts-document-pick.yaml`;
const pickerHierarchy = `<hierarchy>
  <node text="Photos" package="com.google.android.photopicker" bounds="[379,723][493,776]" />
  <node text="Albums" package="com.google.android.photopicker" bounds="[578,723][701,776]" />
  <node clickable="true" enabled="true" package="com.google.android.photopicker" bounds="[944,687][1070,813]" />
</hierarchy>`;

describe('native photo picker overflow targeting', () => {
  it('derives the unique overflow point from the observed Photos/Albums row', () => {
    expect(picker.photoPickerOverflowPoint(pickerHierarchy)).toEqual({
      x: 1007,
      y: 750,
    });
  });

  it.each([
    [
      'missing Photos tab',
      pickerHierarchy.replace('text="Photos"', 'text="Other"'),
    ],
    [
      'foreign application',
      pickerHierarchy.replaceAll(
        'com.google.android.photopicker',
        'example.other',
      ),
    ],
    [
      'disabled overflow',
      pickerHierarchy.replace('enabled="true"', 'enabled="false"'),
    ],
    [
      'ambiguous overflow',
      pickerHierarchy.replace(
        '</hierarchy>',
        '<node clickable="true" enabled="true" package="com.google.android.photopicker" bounds="[800,700][900,800]" /></hierarchy>',
      ),
    ],
    [
      'off-row target',
      pickerHierarchy.replace('[944,687][1070,813]', '[944,1000][1070,1200]'),
    ],
  ])('rejects %s', (_description, hierarchy) => {
    expect(() => picker.photoPickerOverflowPoint(hierarchy)).toThrow(
      'Photo picker',
    );
  });
});

describe('native document activation evidence', () => {
  const button = { trusted: true, matched: true, fileInputMatched: false };
  const input = { trusted: false, matched: false, fileInputMatched: true };

  it('accepts exactly one trusted button click followed by its hidden file input activation', () => {
    expect(() =>
      picker.assertNativeDocumentActivation([button, input]),
    ).not.toThrow();
  });

  it.each([
    ['missing native button', [input]],
    ['synthetic button', [{ ...button, trusted: false }, input]],
    ['wrong originating button', [{ ...button, matched: false }, input]],
    ['wrong file input', [button, { ...input, fileInputMatched: false }]],
    ['trusted follow-on input', [button, { ...input, trusted: true }]],
    ['missing input activation', [button]],
    ['duplicate input activation', [button, input, input]],
    [
      'unrelated synthetic interaction',
      [
        button,
        input,
        { trusted: false, matched: false, fileInputMatched: false },
      ],
    ],
    ['reversed event order', [input, button]],
  ])('rejects %s', (_description, events) => {
    expect(() => picker.assertNativeDocumentActivation(events)).toThrow(
      'Native document activation',
    );
  });
});

function device({ flowFailure } = {}) {
  const calls = [];
  return {
    calls,
    device: {
      adb: vi.fn(async (...args) => {
        calls.push(['adb', ...args]);
        return args[0] === 'exec-out' ? pickerHierarchy : '';
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
      ['adb', 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
      [
        'flow',
        flowPath,
        {
          APP_ID: 'eu.qwky.trinity',
          FILE_NAME: 'space-photo.png',
          OVERFLOW_POINT: '1007,750',
        },
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
      ['adb', 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
      [
        'flow',
        flowPath,
        {
          APP_ID: 'eu.qwky.trinity',
          FILE_NAME: 'space-photo.png',
          OVERFLOW_POINT: '1007,750',
        },
      ],
      ['adb', 'shell', 'rm', '-f', '/sdcard/Download/space-photo.png'],
    ]);
  });
});
