import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  MEDIA_RETENTION_ASSERTION_RECORDS,
  MEDIA_RETENTION_PNG_BASE64,
  MEDIA_RETENTION_SOURCES,
  mediaRetentionAssertions,
  mediaRetentionLightboxAssertions,
  mediaRetentionReadyAssertions,
  mediaRetentionRoomAssertion,
  type MediaRetentionAssertion,
  type MediaRetentionRoomVisit,
  type MediaRetentionVisit,
} from './media-retention-contract.mts';
import {
  openMediaRetentionFixture,
  type MediaRetentionAttachmentReceipt,
  type MediaRetentionFixture,
} from './media-retention-fixture.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const rasterArtifactExtensions = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);
const pinnedPng = Buffer.from(MEDIA_RETENTION_PNG_BASE64, 'base64');

interface MediaRetentionCase {
  readonly id: 'media-retention';
  readonly source: string;
}

interface ReadyImageObservation {
  readonly exactEventRow: boolean;
  readonly matches: number;
  readonly visible: boolean;
  readonly bubbleState: string | null;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly sourceKind: 'blob' | 'other' | 'missing';
}

interface LightboxObservation {
  readonly matches: number;
  readonly visible: boolean;
  readonly exactName: boolean;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly sourceKind: 'blob' | 'other' | 'missing';
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<MediaRetentionAssertion>,
  records: Set<MediaRetentionAssertion>,
  identity: MediaRetentionAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function scanMediaRetentionArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const secretValues = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Media-retention artifact is a file: ${path}`);
      const extension = extname(path).toLowerCase();
      assert(
        !rasterArtifactExtensions.has(extension),
        `Raster artifact was removed from ${path}`,
      );
      const bytes = await readFile(path);
      assert.equal(
        bytes.indexOf(pinnedPng),
        -1,
        `Pinned media bytes are absent from ${path}`,
      );
      if (!textArtifactExtensions.has(extension)) continue;
      const text = bytes.toString('utf8');
      for (const secret of secretValues) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(
        !/\bBearer\s+\S+/u.test(text),
        `Bearer token is absent from ${path}`,
      );
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
      assert(
        !/\bauthorization\b\s*[:=]\s*["']?(?:Bearer|Basic)\s+\S+/iu.test(
          text,
        ),
        `Authorization data is absent from ${path}`,
      );
      assert(!/\bmxc:\/\//u.test(text), `mxc:// URL is absent from ${path}`);
      assert(!/\bblob:/u.test(text), `blob: URL is absent from ${path}`);
      assert(
        !/["'](?:k|iv|sha256)["']\s*:\s*["'][A-Za-z0-9_+/=-]{8,}["']/u.test(
          text,
        ),
        `Attachment key, IV and hash material is absent from ${path}`,
      );
      assert(
        !text.includes(MEDIA_RETENTION_PNG_BASE64),
        `Pinned PNG base64 is absent from ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

async function readReadyImage(
  client: AccountWorkspaceClient,
  attachment: MediaRetentionAttachmentReceipt,
): Promise<ReadyImageObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const {eventId,filename}=${JSON.stringify({
        eventId: attachment.eventId,
        filename: attachment.filename,
      })};
      const visible=element=>{if(!(element instanceof Element))return false;const rectangle=element.getBoundingClientRect(),style=getComputedStyle(element);return rectangle.width>0&&rectangle.height>0&&style.display!=='none'&&style.visibility==='visible'};
      const row=document.querySelector('[data-mid='+JSON.stringify(eventId)+']');
      if(!(row instanceof Element))return{exactEventRow:false,matches:0,visible:false,bubbleState:null,complete:false,naturalWidth:0,sourceKind:'missing'};
      const bubbles=[...row.querySelectorAll('[data-testid="media-bubble"]')].filter(bubble=>bubble.querySelector('img[alt='+JSON.stringify(filename)+']'));
      const bubble=bubbles[0],image=bubble?.querySelector('img[alt='+JSON.stringify(filename)+']');
      const src=image instanceof HTMLImageElement?image.getAttribute('src'):null;
      return{exactEventRow:true,matches:bubbles.length,visible:visible(bubble),bubbleState:bubble?.getAttribute('data-media-state')??null,complete:image instanceof HTMLImageElement&&image.complete,naturalWidth:image instanceof HTMLImageElement?image.naturalWidth:0,sourceKind:src===null?'missing':src.startsWith('blob:')?'blob':'other'};
    })()`,
  );
  assert(value && typeof value === 'object', 'Ready-image observation');
  return value as ReadyImageObservation;
}

async function observeReadyImage(
  client: AccountWorkspaceClient,
  attachment: MediaRetentionAttachmentReceipt,
  visit: MediaRetentionVisit,
  unique: Set<MediaRetentionAssertion>,
  records: Set<MediaRetentionAssertion>,
): Promise<void> {
  const observation = await waitForNativeShellState(
    () => readReadyImage(client, attachment),
    (image) =>
      image.exactEventRow &&
      image.matches === 1 &&
      image.visible &&
      image.bubbleState === 'ready' &&
      image.complete === true &&
      image.naturalWidth > 0,
    `${visit} ${attachment.kind} exact image decoded`,
    client.signal,
    60_000,
  );
  const [bubbleReady, imageComplete, naturalWidthPositive] =
    mediaRetentionReadyAssertions(visit, attachment.kind);
  await recordAssertion(client, unique, records, bubbleReady, {
    exactEventRow: observation.exactEventRow,
    matches: observation.matches,
    visible: observation.visible,
    bubbleState: observation.bubbleState,
    sourceKind: observation.sourceKind,
  });
  await recordAssertion(client, unique, records, imageComplete, {
    complete: observation.complete,
    exactEventRow: observation.exactEventRow,
  });
  await recordAssertion(client, unique, records, naturalWidthPositive, {
    positive: observation.naturalWidth > 0,
    exactEventRow: observation.exactEventRow,
  });
}

async function readLightbox(
  client: AccountWorkspaceClient,
  filename: string,
): Promise<LightboxObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const filename=${JSON.stringify(filename)};
      const visible=element=>{if(!(element instanceof Element))return false;const rectangle=element.getBoundingClientRect(),style=getComputedStyle(element);return rectangle.width>0&&rectangle.height>0&&style.display!=='none'&&style.visibility==='visible'};
      const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(dialog=>dialog.getAttribute('aria-label')===filename);
      const dialog=dialogs[0],image=dialog?.querySelector('img.lightbox__image');
      const src=image instanceof HTMLImageElement?image.getAttribute('src'):null;
      return{matches:dialogs.length,visible:visible(dialog),exactName:dialog instanceof Element&&dialog.getAttribute('aria-label') === filename,complete:image instanceof HTMLImageElement&&image.complete,naturalWidth:image instanceof HTMLImageElement?image.naturalWidth:0,sourceKind:src===null?'missing':src.startsWith('blob:')?'blob':'other'};
    })()`,
  );
  assert(value && typeof value === 'object', 'Lightbox observation');
  return value as LightboxObservation;
}

async function openAndCloseLightbox(
  client: AccountWorkspaceClient,
  attachment: MediaRetentionAttachmentReceipt,
  visit: MediaRetentionVisit,
  unique: Set<MediaRetentionAssertion>,
  records: Set<MediaRetentionAssertion>,
): Promise<void> {
  const rowSelector = `[data-mid=${JSON.stringify(attachment.eventId)}]`;
  const openButtonSelector = `${rowSelector} button[aria-label=${JSON.stringify(
    `Open image ${attachment.filename}`,
  )}]`;
  await client.visible(openButtonSelector, {}, 30_000);
  await client.scrollIntoViewIfNeeded(openButtonSelector, '.scroll');
  await client.tapCurrent(openButtonSelector);
  const observation = await waitForNativeShellState(
    () => readLightbox(client, attachment.filename),
    (image) =>
      image.matches === 1 &&
      image.visible &&
      image.exactName &&
      image.complete === true &&
      image.naturalWidth > 0,
    `${visit} ${attachment.kind} exact lightbox decoded`,
    client.signal,
    30_000,
  );
  const [dialogVisible, imageComplete, naturalWidthPositive, dialogHidden] =
    mediaRetentionLightboxAssertions(visit, attachment.kind);
  await recordAssertion(client, unique, records, dialogVisible, {
    visible: observation.visible,
    exactName: observation.exactName,
    matches: observation.matches,
  });
  await recordAssertion(client, unique, records, imageComplete, {
    complete: observation.complete,
    exactName: observation.exactName,
  });
  await recordAssertion(client, unique, records, naturalWidthPositive, {
    positive: observation.naturalWidth > 0,
    sourceKind: observation.sourceKind,
  });
  await client.tapCurrent('[data-testid="lightbox-close"]');
  const hidden = await waitForNativeShellState(
    () => readLightbox(client, attachment.filename),
    (image) => image.matches === 0 || !image.visible,
    `${visit} ${attachment.kind} exact lightbox hidden`,
    client.signal,
    15_000,
  );
  await recordAssertion(client, unique, records, dialogHidden, {
    hidden: hidden.matches === 0 || !hidden.visible,
    matches: hidden.matches,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  visit: MediaRetentionRoomVisit,
  unique: Set<MediaRetentionAssertion>,
  records: Set<MediaRetentionAssertion>,
): Promise<void> {
  const backToRooms = await client.elements('[data-testid="back-to-rooms"]');
  if (backToRooms.length === 1 && backToRooms[0]!.visible) {
    await client.tapCurrent('[data-testid="back-to-rooms"]');
  } else {
    await client.tapCurrent('[data-testid="rail-rooms"]');
  }
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  const composer = await client.visible(
    '[data-testid="composer-input"]',
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    mediaRetentionRoomAssertion(visit),
    { visible: composer.visible, exactRoom: true },
  );
}

async function closeOpenLightbox(
  client: AccountWorkspaceClient,
): Promise<void> {
  const selector = '[data-testid="lightbox-close"]';
  const candidates = await client.elements(selector);
  if (candidates.some((candidate) => candidate.visible)) {
    await client.tapCurrent(selector);
    await client.waitElements(
      selector,
      (elements) => elements.every((element) => !element.visible),
      'cleanup lightbox hidden',
    );
  }
}

async function runMediaRetentionStage(
  client: AccountWorkspaceClient,
  fixture: MediaRetentionFixture,
  unique: Set<MediaRetentionAssertion>,
  records: Set<MediaRetentionAssertion>,
): Promise<void> {
  await client.record('fixture-receipt', {
    attachmentCount: fixture.attachments.length,
    attachments: fixture.attachments.map((attachment) => ({
      kind: attachment.kind,
      filename: attachment.filename,
      byteLength: attachment.byteLength,
      eventIdPresent: attachment.eventId.length > 0,
    })),
    proof: fixture.proof,
  });
  await client.login(fixture.account);
  await openRoom(
    client,
    fixture.roomA.name,
    'initial.room-a-ready',
    unique,
    records,
  );
  for (const attachment of fixture.attachments) {
    await observeReadyImage(client, attachment, 'initial', unique, records);
    await openAndCloseLightbox(client, attachment, 'initial', unique, records);
  }

  for (const round of [1, 2] as const) {
    const visit: MediaRetentionVisit = `round-${round}`;
    await openRoom(
      client,
      fixture.roomB.name,
      `round-${round}.room-b-ready`,
      unique,
      records,
    );
    await openRoom(
      client,
      fixture.roomA.name,
      `round-${round}.room-a-ready`,
      unique,
      records,
    );
    for (const attachment of fixture.attachments) {
      await observeReadyImage(client, attachment, visit, unique, records);
      await openAndCloseLightbox(client, attachment, visit, unique, records);
    }
  }
}

const cases: readonly MediaRetentionCase[] = [
  {
    id: 'media-retention',
    source: `${MEDIA_RETENTION_SOURCES.definition}; ${MEDIA_RETENTION_SOURCES.helpers}; ${MEDIA_RETENTION_SOURCES.fixture}; ${MEDIA_RETENTION_SOURCES.app}; ${MEDIA_RETENTION_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one media-retention stage exists');
assert.equal(
  mediaRetentionAssertions.length,
  MEDIA_RETENTION_ASSERTION_RECORDS,
);

void test(
  'Android media-retention journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'media-retention',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        matrixResources.cleanup('Scan media-retention diagnostics', () =>
          scanMediaRetentionArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact media-retention diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<MediaRetentionAssertion>();
        const records = new Set<MediaRetentionAssertion>();
        const stages: Array<{
          readonly id: MediaRetentionCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 47;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 1,
                expectedUniqueAssertions: 47,
                expectedAssertionRecords: 47,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: MEDIA_RETENTION_SOURCES,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Media-retention Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
            APPLICATION_ID,
          );
          let fixture: MediaRetentionFixture | undefined;
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: 47,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[media-retention] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            fixture = await openMediaRetentionFixture(matrixResources, signal);
            secrets['SECRET_USERNAME'] = fixture.account.username;
            secrets['SECRET_USER_ID'] = fixture.account.userId;
            secrets['SECRET_PASSWORD'] = fixture.account.password;
            secrets['SECRET_ROOM_A_NAME'] = fixture.roomA.name;
            secrets['SECRET_ROOM_B_NAME'] = fixture.roomB.name;
            for (const attachment of fixture.attachments) {
              secrets[`SECRET_${attachment.kind.toUpperCase()}_EVENT_ID`] =
                attachment.eventId;
            }
            await runMediaRetentionStage(client, fixture, unique, records);
            stage.assertionRecords = records.size;
            assert.equal(
              stage.assertionRecords,
              MEDIA_RETENTION_ASSERTION_RECORDS,
            );
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            try {
              await closeOpenLightbox(client);
            } catch (error) {
              failures.push(error);
            }
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            if (fixture) {
              try {
                await fixture.close();
              } catch (error) {
                failures.push(error);
              }
            }
            try {
              await device.clearApplicationData(APPLICATION_ID);
            } catch (error) {
              failures.push(error);
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            await save();
            console.info(
              `[media-retention] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Media-retention journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, MEDIA_RETENTION_ASSERTION_RECORDS);
        assert.equal(records.size, MEDIA_RETENTION_ASSERTION_RECORDS);
      },
    );
  },
);
