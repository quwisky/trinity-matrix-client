import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { signal, type DebugElement } from '@angular/core';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { TrnSwitchComponent } from '@trinity/components/controls';
import {
  KeywordRulesService,
  NotificationSoundService,
  PushRulesService,
  ReactionNotificationSettingsService,
  type PushRuleToggle,
} from '@trinity/data-access/notifications';
import { TrnToastService } from '@trinity/components/overlay';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { NotificationsSectionComponent } from './notifications-section.component';

const TOGGLES = [
  { id: '.m.rule.master', kind: 'override', label: 'Enable', invert: true },
  { id: '.m.rule.roomnotif', kind: 'override', label: '@room' },
] as unknown as PushRuleToggle[];

// Module-level so a test can set their behaviour BEFORE build() constructs the component —
// the sound switch is seeded in ngOnInit, so configuring it afterwards would be too late.
const soundEnabled = signal(true);
const soundSetOn = vi.fn(() => of(undefined));
const soundConnect = vi.fn();
const soundDisconnect = vi.fn();
const reactionEnabled = signal(false);
const reactionSetOn = vi.fn(() => of(undefined));
const reactionConnect = vi.fn();
const reactionDisconnect = vi.fn();
const activeAccount = signal<string | null>('@me:hs');

beforeEach(() => {
  soundEnabled.set(true);
  soundSetOn.mockReset();
  soundSetOn.mockReturnValue(of(undefined));
  soundConnect.mockReset();
  soundDisconnect.mockReset();
  reactionEnabled.set(false);
  reactionSetOn.mockReset();
  reactionSetOn.mockReturnValue(of(undefined));
  reactionConnect.mockReset();
  reactionDisconnect.mockReset();
  activeAccount.set('@me:hs');
});

async function build(over: { setOn?: Mock } = {}) {
  const setOn = over.setOn ?? vi.fn(() => of(undefined));
  const isOn = vi.fn((t: PushRuleToggle) => t.id === '.m.rule.master');
  const toastShow = vi.fn();
  const { fixture } = await render(NotificationsSectionComponent, {
    providers: [
      MockProvider(PushRulesService, { toggles: TOGGLES, isOn, setOn }),
      MockProvider(NotificationSoundService, {
        enabled: soundEnabled.asReadonly(),
        setOn: soundSetOn,
        connect: soundConnect,
        disconnect: soundDisconnect,
      }),
      MockProvider(ReactionNotificationSettingsService, {
        enabled: reactionEnabled.asReadonly(),
        setOn: reactionSetOn,
        connect: reactionConnect,
        disconnect: reactionDisconnect,
      }),
      MockProvider(MatrixClientService, {
        activeUserId: activeAccount.asReadonly(),
      }),
      // The section renders the keyword block, which would otherwise reach the real
      // MatrixClientService — harmless today only because it reports uninitialised.
      MockProvider(KeywordRulesService, { keywords: () => [] }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return { cmp: fixture.componentInstance, fixture, setOn, toastShow };
}

/** Only the switches rendered for push-rule toggles (excludes the sound one). */
function ruleSwitches(fixture: {
  debugElement: DebugElement;
  nativeElement: HTMLElement;
}) {
  return switches(fixture).slice(0, TOGGLES.length);
}

function switches(fixture: {
  debugElement: DebugElement;
}): { componentInstance: TrnSwitchComponent }[] {
  return fixture.debugElement.queryAll(By.directive(TrnSwitchComponent));
}

describe('NotificationsSectionComponent', () => {
  it('seeds each toggle from the service’s on/off state', async () => {
    const { fixture } = await build();
    // Scoped to the RULE toggles: the sound one is a third switch in the same list
    // but is not one of them, so counting every switch would couple this to it.
    const boxes = ruleSwitches(fixture);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].componentInstance.checked()).toBe(true); // master isOn → true
    expect(boxes[1].componentInstance.checked()).toBe(false);
  });

  it('shows the account’s stored preference', async () => {
    soundEnabled.set(false);
    const { cmp } = await build();

    expect(cmp.soundChecked()).toBe(false);
  });

  it('shows and persists the reaction notification preference', async () => {
    reactionSetOn.mockReturnValue(
      NEVER as unknown as ReturnType<typeof reactionSetOn>,
    );
    const { cmp, fixture } = await build();
    expect(cmp.reactionChecked()).toBe(false);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="notif-reactions"]',
      ),
    ).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'When someone reacts to my message',
    );

    cmp.toggleReactions(true);

    expect(reactionSetOn).toHaveBeenCalledWith(true);
    expect(cmp.reactionChecked()).toBe(true);
  });

  it('does not let a stale successful write clear a new account’s pending reaction write', async () => {
    const oldWrite = new Subject<undefined>();
    const newWrite = new Subject<undefined>();
    reactionSetOn.mockReturnValueOnce(oldWrite).mockReturnValueOnce(newWrite);
    const { cmp, fixture } = await build();

    cmp.toggleReactions(true);
    activeAccount.set('@other:hs');
    fixture.detectChanges();
    cmp.toggleReactions(true);
    expect(cmp.reactionPending()).toBe(true);

    oldWrite.next(undefined);
    oldWrite.complete();

    expect(cmp.reactionPending()).toBe(true);
    expect(cmp.reactionChecked()).toBe(true);
  });

  it('does not let a stale failed write revert a new account’s reaction state', async () => {
    const oldWrite = new Subject<undefined>();
    const newWrite = new Subject<undefined>();
    reactionSetOn.mockReturnValueOnce(oldWrite).mockReturnValueOnce(newWrite);
    const { cmp, fixture, toastShow } = await build();

    cmp.toggleReactions(true);
    activeAccount.set('@other:hs');
    fixture.detectChanges();
    cmp.toggleReactions(true);
    oldWrite.error(new Error('old account failed'));

    expect(cmp.reactionPending()).toBe(true);
    expect(cmp.reactionChecked()).toBe(true);
    expect(toastShow).not.toHaveBeenCalled();
  });

  it('follows the account when the value arrives AFTER the page rendered', async () => {
    // A cold load renders this page before the initial sync delivers account data. Seeding
    // once left the switch showing the default forever; the e2e caught it after a reload.
    const { cmp, fixture } = await build();
    expect(cmp.soundChecked()).toBe(true);

    soundEnabled.set(false);
    fixture.detectChanges();

    expect(cmp.soundChecked()).toBe(false);
  });

  it('shows the new value while the write is still in flight', async () => {
    // NEVER, so the write stays pending: the optimistic value only exists during that
    // window. With an instantly-resolving mock the switch falls straight through to the
    // account's value and the assertion would be measuring nothing.
    soundSetOn.mockReturnValue(
      NEVER as unknown as ReturnType<typeof soundSetOn>,
    );
    const { cmp, fixture } = await build();

    cmp.toggleSound(false);
    fixture.detectChanges();

    expect(soundSetOn).toHaveBeenCalledWith(false);
    expect(cmp.soundChecked()).toBe(false);
  });

  it('reverts the sound switch and toasts when its write fails', async () => {
    soundSetOn.mockReturnValue(
      throwError(() => new Error('nope')) as unknown as ReturnType<
        typeof soundSetOn
      >,
    );
    const { cmp, fixture, toastShow } = await build();
    const before = cmp.soundChecked();

    cmp.toggleSound(!before);
    fixture.detectChanges();

    expect(cmp.soundChecked()).toBe(before);
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('optimistically flips a toggle and persists it', async () => {
    const { cmp, fixture, setOn } = await build();

    cmp.toggle(TOGGLES[1], true);
    fixture.detectChanges();

    expect(setOn).toHaveBeenCalledWith(TOGGLES[1], true);
    expect(cmp.checked(TOGGLES[1])).toBe(true); // optimistic
  });

  it('reverts and toasts when the write fails', async () => {
    const setOn = vi.fn(() => throwError(() => new Error('nope')));
    const { cmp, toastShow } = await build({ setOn });

    cmp.toggle(TOGGLES[1], true);

    expect(cmp.checked(TOGGLES[1])).toBe(false); // reverted
    expect(toastShow).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ variant: 'danger' }),
    );
  });

  it('ignores a change while the same toggle’s write is in flight', async () => {
    // A never-completing write keeps the toggle pending; a re-toggle must not re-call.
    const setOn = vi.fn(() => NEVER);
    const { cmp } = await build({ setOn });

    cmp.toggle(TOGGLES[1], true);
    expect(cmp.isPending(TOGGLES[1])).toBe(true);
    cmp.toggle(TOGGLES[1], false);

    expect(setOn).toHaveBeenCalledTimes(1);
  });

  it('contains the keyword list', async () => {
    // Deleting `<trn-keyword-rules />` from the section removes the whole feature from
    // the app, and every other unit test still passes: the mocked service yields no
    // keywords, so the block contributes no switches either way.
    const { fixture } = await build();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="keyword-rules"]',
      ),
    ).not.toBeNull();
  });
});
