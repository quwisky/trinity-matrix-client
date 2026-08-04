import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  NotificationSoundService,
  actionsWithSound,
  soundTweakOf,
} from './notification-sound.service';

/** The default ruleset shape, trimmed to the rules this service touches. */
function defaults() {
  return {
    override: [
      {
        rule_id: '.m.rule.invite_for_me',
        enabled: true,
        actions: ['notify', { set_tweak: 'sound', value: 'default' }],
      },
      {
        rule_id: '.m.rule.is_user_mention',
        enabled: true,
        actions: [
          'notify',
          { set_tweak: 'sound', value: 'default' },
          { set_tweak: 'highlight' },
        ],
      },
      { rule_id: '.m.rule.member_event', enabled: true, actions: [] },
    ],
    content: [
      {
        rule_id: '.m.rule.contains_user_name',
        enabled: true,
        actions: ['notify', { set_tweak: 'sound', value: 'default' }],
      },
    ],
    room: [],
    sender: [],
    underride: [
      {
        rule_id: '.m.rule.call',
        enabled: true,
        actions: ['notify', { set_tweak: 'sound', value: 'ring' }],
      },
      { rule_id: '.m.rule.message', enabled: true, actions: ['notify'] },
    ],
  };
}

function setup(global: ReturnType<typeof defaults> | null = defaults()) {
  const setPushRuleActions = vi.fn().mockResolvedValue({});
  TestBed.configureTestingModule({
    providers: [
      NotificationSoundService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: {
          pushRules: global ? { global } : undefined,
          setPushRuleActions,
        } as never,
      }),
    ],
  });
  return {
    svc: TestBed.inject(NotificationSoundService),
    setPushRuleActions,
  };
}

/** The actions written for a given rule id, or undefined if it was not written. */
function written(
  calls: ReturnType<typeof vi.fn>,
  id: string,
): unknown[] | undefined {
  const call = calls.mock.calls.find((args) => args[2] === id);
  return call?.[3] as unknown[] | undefined;
}

describe('NotificationSoundService', () => {
  it('reads as on when the default rules still carry their sound', () => {
    expect(setup().svc.isOn()).toBe(true);
  });

  it('reads as off once the tweak is gone from every sounded rule', () => {
    const global = defaults();
    for (const kind of ['override', 'content', 'underride'] as const) {
      for (const rule of global[kind]) {
        rule.actions = rule.actions.filter(
          (a) => typeof a !== 'object' || a.set_tweak !== 'sound',
        );
      }
    }
    expect(setup(global).svc.isOn()).toBe(false);
  });

  it('reads as ON when only SOME rules were silenced', async () => {
    // A failed write, or another client that silenced part of the set. Reporting "off"
    // there would let the next toggle-off be a no-op and leave those rules ringing.
    const global = defaults();
    global.override[0].actions = ['notify'];
    expect(setup(global).svc.isOn()).toBe(true);
  });

  it('removes the tweak from every sounded rule, and touches nothing else', async () => {
    const { svc, setPushRuleActions } = setup();

    await firstValueFrom(svc.setOn(false));

    expect(written(setPushRuleActions, '.m.rule.invite_for_me')).toEqual([
      'notify',
    ]);
    // The highlight tweak is somebody else's setting and must survive.
    expect(written(setPushRuleActions, '.m.rule.is_user_mention')).toEqual([
      'notify',
      { set_tweak: 'highlight' },
    ]);
    // Rules with no sound are never written at all.
    expect(written(setPushRuleActions, '.m.rule.message')).toBeUndefined();
    expect(written(setPushRuleActions, '.m.rule.member_event')).toBeUndefined();
  });

  it('restores each rule’s OWN tone, not one tone for all of them', async () => {
    const global = defaults();
    for (const kind of ['override', 'content', 'underride'] as const) {
      for (const rule of global[kind]) {
        rule.actions = rule.actions.filter(
          (a) => typeof a !== 'object' || a.set_tweak !== 'sound',
        );
      }
    }
    const { svc, setPushRuleActions } = setup(global);

    await firstValueFrom(svc.setOn(true));

    // `.m.rule.call` is the one that is not `default`; restoring `default` there would
    // quietly replace the ring tone with the message tone.
    expect(written(setPushRuleActions, '.m.rule.call')).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'ring' },
    ]);
    expect(written(setPushRuleActions, '.m.rule.invite_for_me')).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'default' },
    ]);
  });

  it('writes nothing when the server defines none of the rules', async () => {
    const { svc, setPushRuleActions } = setup({
      override: [],
      content: [],
      room: [],
      sender: [],
      underride: [],
    });

    await expect(firstValueFrom(svc.setOn(false))).resolves.toBeUndefined();
    expect(setPushRuleActions).not.toHaveBeenCalled();
    expect(svc.isOn()).toBe(false);
  });

  it('does not touch the server when signed out', async () => {
    TestBed.configureTestingModule({
      providers: [
        NotificationSoundService,
        MockProvider(MatrixClientService, { isInitialized: false }),
      ],
    });
    const svc = TestBed.inject(NotificationSoundService);

    expect(svc.isOn()).toBe(false);
    await expect(firstValueFrom(svc.setOn(false))).rejects.toThrow();
  });
});

describe('actionsWithSound', () => {
  const rule = (actions: unknown[]) => ({ actions }) as never;

  it('places the tweak after notify', () => {
    expect(actionsWithSound(rule(['notify']), 'ring')).toEqual([
      'notify',
      { set_tweak: 'sound', value: 'ring' },
    ]);
  });

  it('replaces an existing tweak rather than adding a second', () => {
    expect(
      actionsWithSound(
        rule(['notify', { set_tweak: 'sound', value: 'default' }]),
        'ring',
      ),
    ).toEqual(['notify', { set_tweak: 'sound', value: 'ring' }]);
  });

  it('appends when the rule has no notify action', () => {
    expect(
      actionsWithSound(rule([{ set_tweak: 'highlight' }]), 'default'),
    ).toEqual([
      { set_tweak: 'highlight' },
      { set_tweak: 'sound', value: 'default' },
    ]);
  });

  it('survives a null in the actions array', () => {
    // `typeof null === 'object'`, so a naive check throws on a rule some other client wrote.
    expect(() =>
      actionsWithSound(rule([null, 'notify']), 'default'),
    ).not.toThrow();
    expect(soundTweakOf(rule([null]))).toBeUndefined();
  });
});
