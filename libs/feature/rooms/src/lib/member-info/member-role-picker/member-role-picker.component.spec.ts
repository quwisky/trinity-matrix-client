import {
  ASSIGNABLE_MEMBER_ROLES,
  type ActionAvailability,
  type AssignableMemberRole,
} from '@trinity/data-access/room-administration';
import { render, screen } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { MemberRolePickerComponent } from './member-role-picker.component';

const NO_ADMIN = 'Only admins can make someone an admin.';

async function build(current = 0) {
  const choose = vi.fn<(option: AssignableMemberRole) => void>();
  const { container } = await render(MemberRolePickerComponent, {
    inputs: {
      options: ASSIGNABLE_MEMBER_ROLES,
      current,
      permissionFor: (level: number): ActionAvailability =>
        level === 100
          ? { available: false, reason: NO_ADMIN }
          : { available: true, reason: null },
      targetName: 'Design team',
    },
    on: { choose },
  });
  return { container, choose };
}

const radio = (name: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(`^${name}`) });

describe('MemberRolePickerComponent', () => {
  it('labels the group "Role in Design team"', async () => {
    await build();
    expect(
      screen.getByRole('radiogroup', { name: 'Role in Design team' }),
    ).toBeTruthy();
  });

  it('checks the current role', async () => {
    await build(50);
    expect(radio('Moderator').checked).toBe(true);
    expect(radio('Member').checked).toBe(false);
  });

  it('disables an unavailable option and shows its reason', async () => {
    await build();
    expect(radio('Admin').disabled).toBe(true);
    expect(radio('Moderator').disabled).toBe(false);
    expect(screen.getByText(NO_ADMIN)).toBeTruthy();
  });

  it('choosing the current or a disabled role emits nothing', async () => {
    const { container, choose } = await build(0);
    container
      .querySelector<HTMLElement>('[data-testid="member-info-role-0"]')
      ?.click();
    container
      .querySelector<HTMLElement>('[data-testid="member-info-role-100"]')
      ?.click();
    expect(choose).not.toHaveBeenCalled();
  });

  it('choosing another role emits it', async () => {
    const { container, choose } = await build(0);
    container
      .querySelector<HTMLElement>('[data-testid="member-info-role-50"]')
      ?.click();
    expect(choose).toHaveBeenCalledWith(ASSIGNABLE_MEMBER_ROLES[1]);
  });

  it('options keep data-testid member-info-role-<level>', async () => {
    const { container } = await build();
    for (const { level } of ASSIGNABLE_MEMBER_ROLES) {
      expect(
        container.querySelector(`[data-testid="member-info-role-${level}"]`),
      ).not.toBeNull();
    }
  });
});
