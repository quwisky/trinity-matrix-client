import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom } from 'rxjs';
import { RuleId } from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { PushRulesService, type PushRuleToggle } from './push-rules.service';

function setup(
  rules: {
    override?: { rule_id: string; enabled: boolean }[];
    underride?: { rule_id: string; enabled: boolean }[];
  } = {},
) {
  const setPushRuleEnabled = vi.fn().mockResolvedValue({});
  const instance = {
    pushRules: {
      global: {
        override: rules.override ?? [],
        content: [],
        room: [],
        sender: [],
        underride: rules.underride ?? [],
      },
    },
    setPushRuleEnabled,
  };
  TestBed.configureTestingModule({
    providers: [
      PushRulesService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: instance as never,
      }),
    ],
  });
  return { svc: TestBed.inject(PushRulesService), setPushRuleEnabled };
}

function toggleFor(svc: PushRulesService, id: RuleId): PushRuleToggle {
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
    expect(svc.toggles[0].id).toBe(RuleId.Master);
  });

  it('isOn reads a plain rule’s enabled state', () => {
    const { svc } = setup({
      override: [{ rule_id: RuleId.InviteToSelf, enabled: true }],
    });
    expect(svc.isOn(toggleFor(svc, RuleId.InviteToSelf))).toBe(true);
  });

  it('isOn is true for the master toggle when the master rule is disabled', () => {
    const { svc } = setup({
      override: [{ rule_id: RuleId.Master, enabled: false }],
    });
    // master disabled → notifications are ON
    expect(svc.isOn(toggleFor(svc, RuleId.Master))).toBe(true);
  });

  it('isOn is false for the master toggle when the master rule is enabled', () => {
    const { svc } = setup({
      override: [{ rule_id: RuleId.Master, enabled: true }],
    });
    expect(svc.isOn(toggleFor(svc, RuleId.Master))).toBe(false);
  });

  it('isOn defaults to false for a rule the server does not define', () => {
    const { svc } = setup();
    expect(svc.isOn(toggleFor(svc, RuleId.Message))).toBe(false);
  });

  it('setOn is cold and enables a plain rule on subscribe', async () => {
    const { svc, setPushRuleEnabled } = setup();
    const toggle = toggleFor(svc, RuleId.InviteToSelf);

    const action = svc.setOn(toggle, true);
    expect(setPushRuleEnabled).not.toHaveBeenCalled(); // cold

    await firstValueFrom(action);
    expect(setPushRuleEnabled).toHaveBeenCalledWith(
      'global',
      'override',
      RuleId.InviteToSelf,
      true,
    );
  });

  it('setOn inverts the master rule when writing', async () => {
    const { svc, setPushRuleEnabled } = setup();

    // Turning notifications OFF must ENABLE the master kill-switch.
    await firstValueFrom(svc.setOn(toggleFor(svc, RuleId.Master), false));
    expect(setPushRuleEnabled).toHaveBeenCalledWith(
      'global',
      'override',
      RuleId.Master,
      true,
    );
  });

  // A rule like "mentions my name" exists under different ids across homeservers:
  // modern servers (intentional mentions) expose .m.rule.is_user_mention, older ones
  // .m.rule.contains_display_name, and current Synapse ships BOTH. Binding to a single
  // hardcoded legacy id makes the checkbox unsettable where that id is absent.
  describe('mention toggle across homeserver rule sets', () => {
    it('reads and writes the modern rule when only is_user_mention exists', async () => {
      const { svc, setPushRuleEnabled } = setup({
        override: [{ rule_id: RuleId.IsUserMention, enabled: true }],
      });
      const toggle = byLabel(svc, MENTIONS_LABEL);

      expect(svc.isOn(toggle)).toBe(true);

      await firstValueFrom(svc.setOn(toggle, false));
      expect(setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        RuleId.IsUserMention,
        false,
      );
      expect(setPushRuleEnabled).not.toHaveBeenCalledWith(
        'global',
        'override',
        RuleId.ContainsDisplayName,
        expect.anything(),
      );
    });

    it('falls back to the legacy rule when only contains_display_name exists', async () => {
      const { svc, setPushRuleEnabled } = setup({
        override: [{ rule_id: RuleId.ContainsDisplayName, enabled: false }],
      });
      const toggle = byLabel(svc, MENTIONS_LABEL);

      expect(svc.isOn(toggle)).toBe(false);

      await firstValueFrom(svc.setOn(toggle, true));
      expect(setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        RuleId.ContainsDisplayName,
        true,
      );
    });

    it('writes every present duplicate so the checkbox stays authoritative', async () => {
      const { svc, setPushRuleEnabled } = setup({
        override: [
          { rule_id: RuleId.IsUserMention, enabled: true },
          { rule_id: RuleId.ContainsDisplayName, enabled: true },
        ],
      });

      await firstValueFrom(svc.setOn(byLabel(svc, MENTIONS_LABEL), false));

      expect(setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        RuleId.IsUserMention,
        false,
      );
      expect(setPushRuleEnabled).toHaveBeenCalledWith(
        'global',
        'override',
        RuleId.ContainsDisplayName,
        false,
      );
    });

    it('isOn is true when any present duplicate is enabled', () => {
      const { svc } = setup({
        override: [
          { rule_id: RuleId.IsUserMention, enabled: false },
          { rule_id: RuleId.ContainsDisplayName, enabled: true },
        ],
      });

      expect(svc.isOn(byLabel(svc, MENTIONS_LABEL))).toBe(true);
    });
  });
});
