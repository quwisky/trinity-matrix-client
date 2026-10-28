import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { EngineRequestError } from '@trinity/util/matrix';
import { setupLiveNotificationSettings } from '../contract/live-notification-settings';
import type { DefaultPushRule } from './notification-engine';
import { PushRulesService, type PushRuleToggle } from './push-rules.service';

function setup(rules?: readonly DefaultPushRule[], active?: string | null) {
  const { engine, alice } = setupLiveNotificationSettings({ active });
  if (rules) engine.defineDefaultRules(rules);
  const setPushRulesEnabled = vi.spyOn(engine, 'setPushRulesEnabled');
  return {
    svc: TestBed.inject(PushRulesService),
    engine,
    alice,
    setPushRulesEnabled,
  };
}

const override = (ruleId: string, enabled: boolean): DefaultPushRule => ({
  ruleId,
  kind: 'override',
  enabled,
});

function toggleFor(svc: PushRulesService, id: string): PushRuleToggle {
  const found = svc.toggles.find((t) => t.id === id);
  if (!found) {
    throw new Error(`no toggle for ${id}`);
  }
  return found;
}

function byLabel(svc: PushRulesService, label: string): PushRuleToggle {
  const found = svc.toggles.find((t) => t.label === label);
  if (!found) {
    throw new Error(`no toggle labelled "${label}"`);
  }
  return found;
}

const MENTIONS_LABEL = 'When someone mentions my name';

describe('PushRulesService', () => {
  it('exposes a non-empty ordered catalog of toggles', () => {
    const { svc } = setup();
    expect(svc.toggles.length).toBeGreaterThan(0);
    expect(svc.toggles[0].id).toBe('.m.rule.master');
  });

  it('isOn reads a plain rule’s enabled state', () => {
    const { svc } = setup([override('.m.rule.invite_for_me', true)]);
    expect(svc.isOn(toggleFor(svc, '.m.rule.invite_for_me'))).toBe(true);
  });

  it('isOn is true for the master toggle when the master rule is disabled', () => {
    const { svc } = setup([override('.m.rule.master', false)]);
    // master disabled → notifications are ON
    expect(svc.isOn(toggleFor(svc, '.m.rule.master'))).toBe(true);
  });

  it('isOn is false for the master toggle when the master rule is enabled', () => {
    const { svc } = setup([override('.m.rule.master', true)]);
    expect(svc.isOn(toggleFor(svc, '.m.rule.master'))).toBe(false);
  });

  it('isOn defaults to false for a rule the server does not define', () => {
    const { svc } = setup([]);
    expect(svc.isOn(toggleFor(svc, '.m.rule.message'))).toBe(false);
  });

  it('isOn reads off before sign-in', () => {
    const { svc } = setup(undefined, null);
    expect(svc.isOn(toggleFor(svc, '.m.rule.invite_for_me'))).toBe(false);
  });

  it('setOn is cold and enables a plain rule on subscribe', async () => {
    const { svc, alice, setPushRulesEnabled } = setup([
      override('.m.rule.invite_for_me', false),
    ]);
    const toggle = toggleFor(svc, '.m.rule.invite_for_me');

    const action = svc.setOn(toggle, true);
    expect(setPushRulesEnabled).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setPushRulesEnabled).toHaveBeenCalledWith(
      alice,
      [{ ruleId: '.m.rule.invite_for_me', kind: 'override' }],
      true,
    );
    expect(svc.isOn(toggle)).toBe(true); // readable at once
  });

  it('setOn inverts the master rule when writing', async () => {
    const { svc, alice, setPushRulesEnabled } = setup();

    // Turning notifications OFF must ENABLE the master kill-switch.
    await firstValueFrom(svc.setOn(toggleFor(svc, '.m.rule.master'), false));
    expect(setPushRulesEnabled).toHaveBeenCalledWith(
      alice,
      [{ ruleId: '.m.rule.master', kind: 'override' }],
      true,
    );
  });

  it('setOn targets the canonical rule when the server defines none of its ids', async () => {
    const { svc, alice, setPushRulesEnabled } = setup([]);

    await expect(
      firstValueFrom(svc.setOn(toggleFor(svc, '.m.rule.message'), true)),
    ).rejects.toBeInstanceOf(EngineRequestError); // the fake 404s it, as a server would
    expect(setPushRulesEnabled).toHaveBeenCalledWith(
      alice,
      [{ ruleId: '.m.rule.message', kind: 'underride' }],
      true,
    );
  });

  it('setOn fails before sign-in without writing', async () => {
    const { svc, setPushRulesEnabled } = setup(undefined, null);

    await expect(
      firstValueFrom(svc.setOn(toggleFor(svc, '.m.rule.master'), true)),
    ).rejects.toThrow('Not signed in.');
    expect(setPushRulesEnabled).not.toHaveBeenCalled();
  });

  // A rule like "mentions my name" exists under different ids across homeservers:
  // modern servers (intentional mentions) expose .m.rule.is_user_mention, older ones
  // .m.rule.contains_display_name, and current Synapse ships BOTH. Binding to a single
  // hardcoded legacy id makes the checkbox unsettable where that id is absent.
  describe('mention toggle across homeserver rule sets', () => {
    it('reads and writes the modern rule when only is_user_mention exists', async () => {
      const { svc, alice, setPushRulesEnabled } = setup([
        override('.m.rule.is_user_mention', true),
      ]);
      const toggle = byLabel(svc, MENTIONS_LABEL);

      expect(svc.isOn(toggle)).toBe(true);

      await firstValueFrom(svc.setOn(toggle, false));
      expect(setPushRulesEnabled).toHaveBeenCalledWith(
        alice,
        [{ ruleId: '.m.rule.is_user_mention', kind: 'override' }],
        false,
      );
    });

    it('falls back to the legacy rule when only contains_display_name exists', async () => {
      const { svc, alice, setPushRulesEnabled } = setup([
        override('.m.rule.contains_display_name', false),
      ]);
      const toggle = byLabel(svc, MENTIONS_LABEL);

      expect(svc.isOn(toggle)).toBe(false);

      await firstValueFrom(svc.setOn(toggle, true));
      expect(setPushRulesEnabled).toHaveBeenCalledWith(
        alice,
        [{ ruleId: '.m.rule.contains_display_name', kind: 'override' }],
        true,
      );
    });

    it('writes every present duplicate so the checkbox stays authoritative', async () => {
      const { svc, alice, setPushRulesEnabled } = setup([
        override('.m.rule.is_user_mention', true),
        override('.m.rule.contains_display_name', true),
      ]);

      await firstValueFrom(svc.setOn(byLabel(svc, MENTIONS_LABEL), false));

      expect(setPushRulesEnabled).toHaveBeenCalledWith(
        alice,
        [
          { ruleId: '.m.rule.is_user_mention', kind: 'override' },
          { ruleId: '.m.rule.contains_display_name', kind: 'override' },
        ],
        false,
      );
    });

    it('isOn is true when any present duplicate is enabled', () => {
      const { svc } = setup([
        override('.m.rule.is_user_mention', false),
        override('.m.rule.contains_display_name', true),
      ]);

      expect(svc.isOn(byLabel(svc, MENTIONS_LABEL))).toBe(true);
    });
  });
});
