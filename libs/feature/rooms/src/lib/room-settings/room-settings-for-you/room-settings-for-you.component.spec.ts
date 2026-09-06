import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import {
  RoomNotificationsService,
  type RoomNotifyMode,
} from '@trinity/data-access/notifications';
import { RoomLibraryService } from '@trinity/data-access/room-library';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { RoomSettingsDraftService } from '../room-settings-draft.service';
import { RoomSettingsForYouDraftService } from './room-settings-for-you-draft.service';
import { RoomSettingsForYouComponent } from './room-settings-for-you.component';

const TARGET = { accountId: '@opening:hs', roomId: '!room:hs' } as const;

interface BuildOptions {
  readonly targetAvailable?: boolean;
  readonly readMode?: Mock;
  readonly organisationFor?: Mock;
  readonly setNotificationMode?: Mock;
  readonly setFavourite?: Mock;
  readonly setLowPriority?: Mock;
}

async function build(options: BuildOptions = {}) {
  const targetAvailable = signal(options.targetAvailable ?? true);
  const readMode = options.readMode ?? vi.fn(() => of('mentions'));
  const organisationFor =
    options.organisationFor ??
    vi.fn(() => ({ favourite: false, lowPriority: false }));
  const setNotificationMode =
    options.setNotificationMode ?? vi.fn(() => of(undefined));
  const setFavourite = options.setFavourite ?? vi.fn(() => of(undefined));
  const setLowPriority = options.setLowPriority ?? vi.fn(() => of(undefined));

  const { fixture, container } = await render(RoomSettingsForYouComponent, {
    providers: [
      RoomSettingsForYouDraftService,
      MockProvider(RoomSettingsDraftService, {
        targetAvailable: targetAvailable.asReadonly(),
        targetUnavailableReason: signal<string | null>(null).asReadonly(),
      }),
      MockProvider(RoomNotificationsService, {
        readMode,
        setMode: setNotificationMode,
      }),
      MockProvider(RoomLibraryService, {
        organisationFor,
        setFavourite,
        setLowPriority,
      }),
    ],
  });
  const draft = TestBed.inject(RoomSettingsForYouDraftService);
  draft.start(TARGET);
  fixture.detectChanges();

  return {
    fixture,
    container,
    draft,
    readMode,
    organisationFor,
    setNotificationMode,
    setFavourite,
    setLowPriority,
  };
}

describe('RoomSettingsForYouComponent', () => {
  it('loads the exact opening Account and explains the sidebar shortcut scope', async () => {
    const { container, readMode, organisationFor } = await build();

    expect(readMode).toHaveBeenCalledWith(TARGET.roomId, TARGET.accountId);
    expect(organisationFor).toHaveBeenCalledWith(
      TARGET.accountId,
      TARGET.roomId,
    );
    expect(container.textContent).toContain('combined sidebar row');
    expect(
      container
        .querySelector('[data-testid="room-settings-notify-mentions"]')
        ?.getAttribute('data-state'),
    ).toBe('selected');
  });

  it('submits through Signal Forms and writes only to the opening Account', async () => {
    const {
      container,
      draft,
      setNotificationMode,
      setFavourite,
      setLowPriority,
    } = await build();
    draft.setNotificationMode('mute');
    draft.setFavourite(true);
    draft.setLowPriority(true);
    const submit = new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true,
    });

    container
      .querySelector('[data-testid="room-settings-for-you-form"]')
      ?.dispatchEvent(submit);

    expect(submit.defaultPrevented).toBe(true);
    expect(setNotificationMode).toHaveBeenCalledWith(
      TARGET.roomId,
      'mute',
      TARGET.accountId,
    );
    expect(setFavourite).toHaveBeenCalledWith(
      TARGET.roomId,
      true,
      TARGET.accountId,
    );
    expect(setLowPriority).toHaveBeenCalledWith(
      TARGET.roomId,
      true,
      TARGET.accountId,
    );
  });

  it('retains failed fields and retries only what remains', async () => {
    const setNotificationMode = vi
      .fn<() => Observable<void>>()
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValueOnce(of(undefined));
    const setFavourite = vi.fn(() => of(undefined));
    const { draft } = await build({ setNotificationMode, setFavourite });
    draft.setNotificationMode('mute');
    draft.setFavourite(true);

    draft.save();

    expect(draft.feedback()?.message).toContain('still unsaved');
    expect(draft.dirty()).toBe(true);
    draft.save();
    expect(setNotificationMode).toHaveBeenCalledTimes(2);
    expect(setFavourite).toHaveBeenCalledTimes(1);
    expect(draft.dirty()).toBe(false);
  });

  it('shows pending feedback until a write finishes', async () => {
    const completion = new Subject<void>();
    const { draft } = await build({
      setNotificationMode: vi.fn(() => completion.asObservable()),
    });
    draft.setNotificationMode('mute');

    draft.save();

    expect(draft.saving()).toBe(true);
    expect(draft.feedback()).toMatchObject({ tone: 'pending' });
    completion.next();
    completion.complete();
    expect(draft.saving()).toBe(false);
  });

  it('shows loading without editable guessed defaults', async () => {
    const mode = new Subject<RoomNotifyMode>();
    const { fixture, container } = await build({
      readMode: vi.fn(() => mode.asObservable()),
    });

    expect(container.textContent).toContain('Loading your Room preferences');
    expect(container.querySelector('trn-radio-group')).toBeNull();
    mode.next('all');
    mode.complete();
    fixture.detectChanges();
    expect(container.textContent).toContain('All messages');
  });

  it('shows a failed read and retries before exposing controls', async () => {
    const readMode = vi
      .fn<() => Observable<RoomNotifyMode>>()
      .mockReturnValueOnce(throwError(() => new Error('offline')))
      .mockReturnValueOnce(of('all'));
    const { fixture, container, draft } = await build({ readMode });

    expect(container.textContent).toContain('Couldn’t read Room preferences');
    expect(container.querySelector('trn-radio-group')).toBeNull();
    draft.retryLoad();
    fixture.detectChanges();
    expect(container.textContent).toContain('All messages');
  });

  it('shows unavailable without editable guessed defaults', async () => {
    const { container } = await build({
      organisationFor: vi.fn(() => null),
    });

    expect(container.textContent).toContain('Room preferences unavailable');
    expect(container.querySelector('trn-radio-group')).toBeNull();
  });

  it('keeps personal controls independent of Room governance permissions', async () => {
    const { container } = await build();

    expect(
      container
        .querySelector('[data-testid="room-settings-favourite"] input')
        ?.hasAttribute('disabled'),
    ).toBe(false);
  });
});

afterEach(() => TestBed.resetTestingModule());
