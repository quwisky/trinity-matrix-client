import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { HlmCheckbox } from '@trinity/helm/checkbox';
import {
  KeywordRulesService,
  PushRulesService,
  type PushRuleToggle,
} from '@trinity/data-access-notifications';
import { TrnToastService } from '@trinity/helm/overlay';
import { NotificationsSectionComponent } from './notifications-section.component';

const TOGGLES = [
  { id: '.m.rule.master', kind: 'override', label: 'Enable', invert: true },
  { id: '.m.rule.roomnotif', kind: 'override', label: '@room' },
] as unknown as PushRuleToggle[];

async function build(over: { setOn?: ReturnType<typeof vi.fn> } = {}) {
  const setOn = over.setOn ?? vi.fn(() => of(undefined));
  const isOn = vi.fn((t: PushRuleToggle) => t.id === '.m.rule.master');
  const toastShow = vi.fn();
  const { fixture } = await render(NotificationsSectionComponent, {
    providers: [
      MockProvider(PushRulesService, { toggles: TOGGLES, isOn, setOn }),
      // The section renders the keyword block, which would otherwise reach the real
      // MatrixClientService — harmless today only because it reports uninitialised.
      MockProvider(KeywordRulesService, { keywords: () => [] }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return { cmp: fixture.componentInstance, fixture, setOn, toastShow };
}

function checkboxes(fixture: {
  debugElement: {
    queryAll: (p: unknown) => { componentInstance: HlmCheckbox }[];
  };
}) {
  return fixture.debugElement.queryAll(By.directive(HlmCheckbox));
}

describe('NotificationsSectionComponent', () => {
  it('seeds each toggle from the service’s on/off state', async () => {
    const { fixture } = await build();
    const boxes = checkboxes(fixture);
    expect(boxes).toHaveLength(2);
    expect(boxes[0].componentInstance.checked()).toBe(true); // master isOn → true
    expect(boxes[1].componentInstance.checked()).toBe(false);
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
      expect.objectContaining({ variant: 'destructive' }),
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
    // keywords, so the block contributes no checkboxes either way.
    const { fixture } = await build();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="keyword-rules"]',
      ),
    ).not.toBeNull();
  });
});
