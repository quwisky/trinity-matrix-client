import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { ConversationRuntime } from '@trinity/data-access/timeline';
import { MockComponent } from 'ng-mocks';
import { beforeAll } from 'vitest';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { provideRoomMessageListCommands } from '../message-list/message-list-commands';
import { MessageListComponent } from '../message-list/message-list.component';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from './conversation-timeline.stub';
import { messageView } from './message-view.fixture';
import { featureRoomsTestProviders } from './test-providers';

/**
 * Render once before the file's tests. Tests run JIT: the first render of a large tree compiles
 * every component in it, which takes seconds on a busy machine and would otherwise count against
 * the first test's timeout.
 */
export function compileBeforeTests(
  render: () => ComponentFixture<unknown>,
): void {
  beforeAll(() => {
    TestBed.configureTestingModule({ providers: featureRoomsTestProviders() });
    const fixture = render();
    fixture.detectChanges();
    fixture.destroy();
    TestBed.resetTestingModule();
  });
}

/** {@link compileBeforeTests} for a spec of the message list: two rows, the composer mocked. */
export function compileMessageListBeforeTests(): void {
  compileBeforeTests(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    TestBed.configureTestingModule({
      providers: [provideRoomMessageListCommands()],
    });
    TestBed.overrideComponent(MessageListComponent, {
      remove: { imports: [MessageComposerComponent] },
      add: { imports: [MockComponent(MessageComposerComponent)] },
    });
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('messages', [
      messageView({ id: '$a', senderId: '@a:hs', timestamp: 1000 }),
      messageView({ id: '$b', senderId: '@b:hs', timestamp: 2000 }),
    ]);
    return fixture;
  });
}
