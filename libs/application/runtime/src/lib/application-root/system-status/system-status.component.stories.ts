import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  applicationConfig,
  type Meta,
  type StoryObj,
} from '@storybook/angular-vite';
import { AccountIdentitiesService } from '@trinity/data-access/identity';
import { BUILD_INFO } from '@trinity/platform-native';
import { of } from 'rxjs';
import { ApplicationRuntimeService } from '../../application-runtime.service';
import { CapabilityHealthService } from '../../capability-health.service';
import { SystemStatusComponent } from './system-status.component';

@Component({
  selector: 'trn-system-status-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SystemStatusComponent],
  template: '<trn-system-status />',
})
class SystemStatusStoryComponent {
  readonly degraded = input(true);
  private readonly health = inject(CapabilityHealthService);
  private readonly context = Symbol('storybook-account');

  constructor() {
    effect(() => {
      if (!this.degraded()) {
        this.health.reset();
        return;
      }
      this.health.presentForAccount(this.context, '@alice:example.org');
      this.health.report(
        {
          capability: 'room-library',
          operation: 'hydrate-order',
          context: this.context,
          generation: 1,
          demanded: true,
          preparation: 'failed',
          ownership: 'released',
          condition: 'degraded',
          code: 'room-order-storage-unavailable',
        },
        () => of({ kind: 'success' as const }),
      );
    });
  }
}

const meta: Meta<SystemStatusStoryComponent> = {
  title: 'Application/System Status',
  component: SystemStatusStoryComponent,
  decorators: [
    applicationConfig({
      providers: [
        {
          provide: ApplicationRuntimeService,
          useValue: {
            state: signal({ phase: 'ready', attempt: 1, settlements: [] }),
          },
        },
        {
          provide: BUILD_INFO,
          useValue: { version: '0.1.0', commit: 'storybook', builtAt: '' },
        },
        {
          provide: AccountIdentitiesService,
          useValue: {
            identityOf: () => ({
              userId: '@alice:example.org',
              displayName: 'Alice',
              avatarMxc: null,
            }),
          },
        },
      ],
    }),
  ],
};

export default meta;
type Story = StoryObj<SystemStatusStoryComponent>;

export const DegradedAccount: Story = { args: { degraded: true } };
export const AllWorking: Story = { args: { degraded: false } };
