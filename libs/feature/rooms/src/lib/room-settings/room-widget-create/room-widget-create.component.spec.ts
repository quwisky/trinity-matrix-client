import { TestBed } from '@angular/core/testing';
import { TrnToastService } from '@trinity/components/overlay';
import {
  WidgetManagementError,
  WidgetManagementService,
} from '@trinity/data-access/widgets';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { RoomWidgetCreateComponent } from './room-widget-create.component';

async function build() {
  const create = vi.fn(() => of('widget-id'));
  const toast = vi.fn();
  const rendered = await render(RoomWidgetCreateComponent, {
    inputs: { roomId: '!room:example.org' },
    providers: [
      MockProvider(WidgetManagementService, { create }),
      MockProvider(TrnToastService, { show: toast }),
    ],
  });
  return {
    ...rendered,
    component: rendered.fixture.componentInstance,
    create,
    toast,
  };
}

function validDraft(component: RoomWidgetCreateComponent): void {
  component.form.name().value.set('Planning board');
  component.form.rawUrl().value.set('https://widgets.example/$matrix_room_id');
}

describe('RoomWidgetCreateComponent', () => {
  it('shows field-specific validation and focuses the first invalid field', async () => {
    const { component, container, fixture, create } = await build();
    component.form().markAsTouched();
    await component.add();
    fixture.detectChanges();

    expect(create).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="room-widget-create-name-error"]'),
    ).toHaveTextContent('Enter a widget name');
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="room-widget-create-name"]'),
    );
  });

  it('creates once, resets the fields, and reports success', async () => {
    const { component, create, toast } = await build();
    validDraft(component);

    await component.add();

    expect(create).toHaveBeenCalledWith('!room:example.org', {
      name: 'Planning board',
      rawUrl: 'https://widgets.example/$matrix_room_id',
    });
    expect(component.form.name().value()).toBe('');
    expect(toast).toHaveBeenCalledWith(
      'Widget added.',
      expect.objectContaining({ variant: 'success' }),
    );
  });

  it('suppresses a duplicate add while the first request is pending', async () => {
    const { component, create } = await build();
    const pending = new Subject<string>();
    create.mockReturnValue(pending);
    validDraft(component);

    const first = component.add();
    const duplicate = component.add();
    await duplicate;

    expect(create).toHaveBeenCalledOnce();
    pending.next('widget-id');
    pending.complete();
    await first;
  });

  it('does not submit Enter while an IME is composing', async () => {
    const { component, create } = await build();
    validDraft(component);
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    Object.defineProperty(event, 'isComposing', { value: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    component.onEnter(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('renders a permission loss returned by the write-time recheck', async () => {
    const { component, container, fixture } = await build();
    vi.mocked(TestBed.inject(WidgetManagementService).create).mockReturnValue(
      throwError(() => new WidgetManagementError('forbidden')),
    );
    validDraft(component);

    await component.add();
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid="room-widget-create-error"]'),
    ).toHaveTextContent('no longer have permission');
    expect(component.form.name().value()).toBe('Planning board');
  });

  it('retries a transient failure without requiring a field edit', async () => {
    const { component, create } = await build();
    create
      .mockReturnValueOnce(throwError(() => new Error('unavailable')))
      .mockReturnValueOnce(of('widget-id'));
    validDraft(component);

    await component.add();
    expect(component.form().valid()).toBe(true);
    expect(component.form.name().value()).toBe('Planning board');

    await component.add();

    expect(create).toHaveBeenCalledTimes(2);
    expect(component.form.name().value()).toBe('');
  });
});
