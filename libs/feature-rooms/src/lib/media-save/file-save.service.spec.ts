import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { FileSaveService } from './file-save.service';

// Capacitor + the native plugins are unavailable under jsdom; mock them so both
// the web fallback and the native write+share branch can be exercised.
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => true),
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { writeFile: vi.fn(), deleteFile: vi.fn() },
  Directory: { Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({
  Share: { share: vi.fn() },
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const writeFile = Filesystem.writeFile as unknown as Mock;
const deleteFile = Filesystem.deleteFile as unknown as Mock;
const share = Share.share as unknown as Mock;

function build(): FileSaveService {
  TestBed.configureTestingModule({ providers: [FileSaveService] });
  return TestBed.inject(FileSaveService);
}

describe('FileSaveService', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    writeFile.mockReset().mockResolvedValue({ uri: 'file:///cache/pic.png' });
    deleteFile.mockReset().mockResolvedValue(undefined);
    share.mockReset().mockResolvedValue(undefined);
  });

  describe('web fallback', () => {
    let origCreate: typeof URL.createObjectURL;
    let origRevoke: typeof URL.revokeObjectURL;
    let createObjectURL: Mock;
    let revokeObjectURL: Mock;

    beforeEach(() => {
      isNative.mockReturnValue(false);
      // jsdom doesn't implement the object-URL API.
      origCreate = URL.createObjectURL;
      origRevoke = URL.revokeObjectURL;
      createObjectURL = vi.fn(() => 'blob:dl');
      revokeObjectURL = vi.fn();
      URL.createObjectURL =
        createObjectURL as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL =
        revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    });

    afterEach(() => {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      vi.restoreAllMocks();
    });

    it('downloads via an <a download> link and revokes the object URL', async () => {
      const svc = build();
      expect(svc.nativeAvailable).toBe(false);
      // Capture the download attribute at click time (and stop jsdom navigation).
      let downloadName: string | undefined;
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          downloadName = this.download;
        },
      );

      await firstValueFrom(svc.save(new Blob(['x']), 'pic.png'));

      expect(downloadName).toBe('pic.png');
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:dl');
      // The native plugins are never touched on the web.
      expect(writeFile).not.toHaveBeenCalled();
      expect(share).not.toHaveBeenCalled();
    });
  });

  describe('native', () => {
    beforeEach(() => isNative.mockReturnValue(true));

    it('writes the bytes to the cache, shares, then deletes the temp file', async () => {
      const svc = build();
      expect(svc.nativeAvailable).toBe(true);

      await firstValueFrom(svc.save(new Blob(['hello']), 'pic.png'));

      expect(writeFile).toHaveBeenCalledTimes(1);
      const opts = writeFile.mock.calls[0][0];
      expect(opts.path).toBe('pic.png');
      expect(opts.directory).toBe('CACHE');
      expect(typeof opts.data).toBe('string'); // base64, no data: prefix
      expect(opts.data).not.toContain(',');
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({ files: ['file:///cache/pic.png'] }),
      );
      // Decrypted plaintext must not linger in the cache after the sheet closes.
      expect(deleteFile).toHaveBeenCalledWith({
        path: 'pic.png',
        directory: 'CACHE',
      });
    });

    it('reduces a path-bearing filename to a safe basename', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), 'a/b\\c.png'));

      expect(writeFile.mock.calls[0][0].path).toBe('a_b_c.png');
    });

    it('falls back to "download" for empty or dot-only filenames', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), '   '));
      expect(writeFile.mock.calls[0][0].path).toBe('download');

      await firstValueFrom(svc.save(new Blob(['x']), '..'));
      expect(writeFile.mock.calls[1][0].path).toBe('download');
    });

    it('truncates an over-long filename while keeping its extension', async () => {
      const svc = build();

      await firstValueFrom(svc.save(new Blob(['x']), `${'a'.repeat(400)}.png`));

      const path = writeFile.mock.calls[0][0].path as string;
      expect(path.length).toBe(200);
      expect(path.endsWith('.png')).toBe(true);
    });

    it('swallows a user-cancelled share (not a failure) and still cleans up', async () => {
      share.mockRejectedValueOnce(new Error('Share canceled'));
      const svc = build();

      await expect(
        firstValueFrom(svc.save(new Blob(['x']), 'pic.png')),
      ).resolves.toBeUndefined();
      expect(deleteFile).toHaveBeenCalled();
    });

    it('propagates a genuine share failure', async () => {
      share.mockRejectedValueOnce(new Error('kaboom'));
      const svc = build();

      await expect(
        firstValueFrom(svc.save(new Blob(['x']), 'pic.png')),
      ).rejects.toThrow(/kaboom/);
    });
  });
});
