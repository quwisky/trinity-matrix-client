import type { MediaKind } from '@trinity/util/matrix';

declare const presentedMediaBrand: unique symbol;
declare const stagedMediaBrand: unique symbol;

/** Safe media metadata exposed by Message Presentation; source and crypto material stay opaque. */
export interface PresentedMediaReference {
  readonly [presentedMediaBrand]: true;
  readonly id: string;
  readonly kind: MediaKind;
  readonly filename: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
  readonly isVoice?: boolean;
  readonly waveform?: readonly number[];
}

/** One host-acquired file retained by Media Pipeline for validation, transfer, and retry. */
export interface StagedMediaReference {
  readonly [stagedMediaBrand]: true;
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly previewUrl: string | null;
}

export type MediaStageFailure = 'empty-file';

export type MediaStageOutcome =
  | { readonly kind: 'staged'; readonly media: StagedMediaReference }
  | {
      readonly kind: 'rejected';
      readonly failure: MediaStageFailure;
      readonly retryable: false;
    };

export interface MediaConversationKey {
  readonly accountId: string;
  readonly roomId: string;
}

export interface MediaTransferRequest {
  readonly key: MediaConversationKey;
  readonly threadRootId?: string;
  readonly media: StagedMediaReference;
  readonly caption: string;
}

export type MediaTransferFailure =
  | 'conversation-unavailable'
  | 'staged-media-unavailable'
  | 'upload-rejected'
  | 'send-rejected';

export type MediaTransferEvent =
  | {
      readonly kind: 'progress';
      readonly phase: 'validating' | 'encrypting' | 'uploading' | 'sending';
      readonly fraction: number;
    }
  | { readonly kind: 'sent'; readonly eventId: string }
  | {
      readonly kind: 'rejected';
      readonly failure: MediaTransferFailure;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'indeterminate';
      readonly failure: 'local-echo-missing' | 'send-in-flight';
      readonly retryable: true;
    };
