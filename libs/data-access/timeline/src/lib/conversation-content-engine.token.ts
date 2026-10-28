import { InjectionToken, inject } from '@angular/core';
import type { ConversationContentEngine } from './conversation-content-engine';
import { JsSdkConversationContentEngine } from './js-sdk/js-sdk-conversation-content-engine';

export const CONVERSATION_CONTENT_ENGINE =
  new InjectionToken<ConversationContentEngine>('CONVERSATION_CONTENT_ENGINE', {
    providedIn: 'root',
    factory: () => inject(JsSdkConversationContentEngine),
  });
