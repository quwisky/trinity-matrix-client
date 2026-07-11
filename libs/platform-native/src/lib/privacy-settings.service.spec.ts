import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { PrivacySettingsService } from './privacy-settings.service';

vi.mock('@capacitor/preferences', () => ({
  Preferences: { get: vi.fn(), set: vi.fn() },
}));

const get = Preferences.get as unknown as Mock;
const set = Preferences.set as unknown as Mock;

const KEY = 'trinity.privacy.send-read-receipts';

describe('PrivacySettingsService', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ value: null });
    set.mockReset().mockResolvedValue(undefined);
  });

  function service(): PrivacySettingsService {
    TestBed.configureTestingModule({ providers: [PrivacySettingsService] });
    return TestBed.inject(PrivacySettingsService);
  }

  it('defaults send-read-receipts to on', () => {
    expect(service().sendReadReceipts()).toBe(true);
  });

  it('keeps the default (on) when nothing is stored', async () => {
    const svc = service();
    await svc.init();
    expect(svc.sendReadReceipts()).toBe(true);
  });

  it('restores a stored "false" preference on init', async () => {
    get.mockResolvedValue({ value: 'false' });
    const svc = service();
    await svc.init();
    expect(svc.sendReadReceipts()).toBe(false);
    expect(get).toHaveBeenCalledWith({ key: KEY });
  });

  it('treats a stored "true" value as on', async () => {
    get.mockResolvedValue({ value: 'true' });
    const svc = service();
    await svc.init();
    expect(svc.sendReadReceipts()).toBe(true);
  });

  it('keeps the default (on) when storage throws', async () => {
    get.mockRejectedValue(new Error('unavailable'));
    const svc = service();
    await svc.init();
    expect(svc.sendReadReceipts()).toBe(true);
  });

  it('setSendReadReceipts updates the signal and persists the choice', () => {
    const svc = service();

    svc.setSendReadReceipts(false);
    expect(svc.sendReadReceipts()).toBe(false);
    expect(set).toHaveBeenCalledWith({ key: KEY, value: 'false' });

    svc.setSendReadReceipts(true);
    expect(svc.sendReadReceipts()).toBe(true);
    expect(set).toHaveBeenLastCalledWith({ key: KEY, value: 'true' });
  });

  it('defaults link previews to on', () => {
    expect(service().linkPreviews()).toBe(true);
  });

  it('restores a stored "false" link-previews preference on init', async () => {
    get.mockResolvedValue({ value: 'false' });
    const svc = service();
    await svc.init();
    expect(svc.linkPreviews()).toBe(false);
    expect(get).toHaveBeenCalledWith({ key: 'trinity.privacy.link-previews' });
  });

  it('setLinkPreviews updates the signal and persists the choice', () => {
    const svc = service();

    svc.setLinkPreviews(false);
    expect(svc.linkPreviews()).toBe(false);
    expect(set).toHaveBeenCalledWith({
      key: 'trinity.privacy.link-previews',
      value: 'false',
    });
  });
});
