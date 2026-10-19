import {
  ASSIGNABLE_MEMBER_ROLES,
  type ActionAvailability,
  type AssignableMemberRole,
} from '@trinity/data-access/room-administration';
import { render, screen, waitFor } from '@trinity/testing';
import { describe, expect, it, vi } from 'vitest';
import { MemberRolePickerComponent } from './member-role-picker.component';

const NO_ADMIN = 'Only admins can make someone an admin.';

async function build(current = 0) {
  const choose = vi.fn<(option: AssignableMemberRole) => void>();
  const { container, fixture } = await render(MemberRolePickerComponent, {
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
  return { container, choose, fixture };
}

const radio = (name: string) =>
  screen.getByRole<HTMLInputElement>('radio', { name: new RegExp(`^${name}`) });
const applyButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Change role' });

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

  it('"Change role" is disabled until another role is chosen', async () => {
    await build(0);
    expect(applyButton().disabled).toBe(true);

    radio('Moderator').click();

    await waitFor(() => expect(applyButton().disabled).toBe(false));
  });

  it('arrow keys move the choice without opening a confirmation', async () => {
    // A native arrow key checks the next radio and fires `change`, exactly like a click.
    const { choose } = await build(0);

    radio('Moderator').click();
    radio('Member').click();
    radio('Moderator').click();

    expect(choose).not.toHaveBeenCalled();
    expect(radio('Moderator').checked).toBe(true);
  });

  it('"Change role" emits the chosen role and keeps it checked until the role changes', async () => {
    const { choose, fixture } = await build(0);

    radio('Moderator').click();
    await waitFor(() => expect(applyButton().disabled).toBe(false));
    applyButton().click();
    await fixture.whenStable();

    expect(choose).toHaveBeenCalledWith(ASSIGNABLE_MEMBER_ROLES[1]);
    // A cancelled confirmation leaves the choice in place for another try.
    expect(radio('Moderator').checked).toBe(true);
    expect(applyButton().disabled).toBe(false);

    fixture.componentRef.setInput('current', 50);
    await fixture.whenStable();
    expect(radio('Moderator').checked).toBe(true);
    expect(applyButton().disabled).toBe(true);
  });

  it('resets the choice when the real role changes', async () => {
    const { fixture } = await build(0);
    radio('Moderator').click();

    fixture.componentRef.setInput('current', 100);
    await fixture.whenStable();

    expect(radio('Admin').checked).toBe(true);
    expect(radio('Moderator').checked).toBe(false);
  });

  it('keeps a picked role when the options array is replaced with the same roles', async () => {
    const { fixture } = await build(0);
    radio('Moderator').click();
    await waitFor(() => expect(applyButton().disabled).toBe(false));

    fixture.componentRef.setInput(
      'options',
      ASSIGNABLE_MEMBER_ROLES.map((role) => ({ ...role })),
    );
    await fixture.whenStable();

    expect(radio('Moderator').checked).toBe(true);
    expect(applyButton().disabled).toBe(false);
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
