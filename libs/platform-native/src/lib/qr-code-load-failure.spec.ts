import { describe, expect, it, vi } from 'vitest';
import { QrCodeService } from './qr-code.service';

const offline = vi.hoisted(() => ({ value: true }));

vi.mock('qr/decode.js', async (importOriginal) => {
  if (offline.value) {
    throw new Error('Failed to fetch dynamically imported module');
  }
  return importOriginal();
});

describe('QrCodeService when the library fails to load', () => {
  it('forgets the failure so the next load can succeed', async () => {
    const service = new QrCodeService();

    await expect(service.load()).rejects.toThrow();
    offline.value = false;
    vi.resetModules();

    await expect(service.load()).resolves.toBeDefined();
  });
});
