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
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  LINK_PREVIEW_ASSERTION_RECORDS,
  LINK_PREVIEW_SOURCES,
  LINK_PREVIEW_TITLE,
  linkPreviewAssertions as assertions,
} from './link-preview-contract.mts';
import {
  openLinkPreviewNetworkObserver,
  type LinkPreviewNetworkObserver,
} from './link-preview-network-observer.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';

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
const allAssertionIds = Object.values(assertions);
type LinkPreviewAssertion = (typeof allAssertionIds)[number];

interface LinkPreviewCase {
  readonly id: 'link-preview';
  readonly source: string;
}

interface LinkPreviewStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly signal: AbortSignal;
  readonly secrets: Record<string, string>;
  readonly unique: Set<LinkPreviewAssertion>;
  readonly records: Set<LinkPreviewAssertion>;
  setObserver(observer: LinkPreviewNetworkObserver): void;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function matrixRecord(
  value: unknown,
  description: string,
): Readonly<Record<string, unknown>> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    description,
  );
  return value as Readonly<Record<string, unknown>>;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<LinkPreviewAssertion>,
  records: Set<LinkPreviewAssertion>,
  identity: LinkPreviewAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function scanLinkPreviewArtifacts(
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
      assert(entry.isFile(), `Link-preview artifact is a file: ${path}`);
      const extension = extname(path).toLowerCase();
      assert(
        !rasterArtifactExtensions.has(extension),
        `Raster artifact was removed from ${path}`,
      );
      if (!textArtifactExtensions.has(extension)) continue;
      const text = await readFile(path, 'utf8');
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
        ) &&
          !/\b(?:cookie|set-cookie)\b["']?\s*[:=]\s*["'][^"']+["']/iu.test(
            text,
          ),
        `Request authentication data is absent from ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

async function runLinkPreviewStage(
  context: LinkPreviewStageContext,
): Promise<void> {
  const { client, fixtures, signal, secrets, unique, records } = context;
  const account: NodeWorkspaceAccount = await fixtures.account(
    'link-preview-owner',
  );
  const room = await fixtures.createRoom(account, {
    name: `Links ${account.username}`,
    preset: 'private_chat',
  });
  const ogUrl = process.env['TRINITY_E2E_NETWORK_CONTAINER']
    ? 'http://localhost:8080/og'
    : 'http://caddy:8080/og';
  const messageBody = `look ${account.username}: ${ogUrl}`;
  const transactionId = `link-preview-${account.username}`;
  secrets['SECRET_ROOM_NAME'] = room.name;
  secrets['SECRET_MESSAGE_BODY'] = messageBody;

  const encryptionBefore = await fixtures.roomState(
    account,
    room.id,
    'm.room.encryption',
  );
  assert.equal(encryptionBefore, undefined, 'Link-preview Room is plaintext');
  const eventId = await fixtures.sendMessage(
    account,
    room.id,
    messageBody,
    transactionId,
  );
  const event = await fixtures.roomEvent(account, room.id, eventId);
  const content = matrixRecord(event['content'], 'Link-preview message content');
  assert(event['type'] === 'm.room.message');
  assert(event['sender'] === account.userId);
  assert(content['msgtype'] === 'm.text');
  assert(content['body'] === messageBody);
  const encryptionAfter = await fixtures.roomState(
    account,
    room.id,
    'm.room.encryption',
  );
  assert.equal(encryptionAfter, undefined, 'Link-preview Room remains plaintext');
  await client.record('plaintext-fixture', {
    preset: 'private_chat',
    encryptionStateAbsentBeforeSend: encryptionBefore === undefined,
    encryptionStateAbsentAfterSend: encryptionAfter === undefined,
    exactMessageEvent: true,
    exactUrl: ogUrl,
  });

  const observer = await openLinkPreviewNetworkObserver(
    client,
    account.homeserver,
    ogUrl,
    signal,
  );
  context.setObserver(observer);
  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, 60_000);
  await client.tapCurrent('.channel', { text: room.name });

  // Selectors reach the job log, so the card is found without the event id:
  // the Room holds one message, and a read-only observation binds the card
  // to the exact seeded event.
  const cardSelector = '.scroll .msg[data-mid^="$"] [data-testid="link-preview"]';
  const card = await client.visible(cardSelector, {}, 60_000);
  const binding = await client.eventIdentity(cardSelector, {}, eventId);
  assert(
    binding.matches === 1 && binding.exactEvent,
    'Link-preview card belongs to the exact seeded event',
  );
  await recordAssertion(client, unique, records, assertions.cardVisible, {
    visible: card.visible,
    exactEvent: binding.exactEvent,
    matches: binding.matches,
  });

  const title = await client.visible(
    `${cardSelector} .link-preview__title`,
    { exactText: LINK_PREVIEW_TITLE },
    30_000,
  );
  assert.equal(title.text, LINK_PREVIEW_TITLE);
  await recordAssertion(client, unique, records, assertions.exactTitle, {
    visible: title.visible,
    title: title.text,
  });

  assert.equal(card.attributes['href'], ogUrl);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.exactDestination,
    { href: card.attributes['href'] },
  );

  const preview = await observer.waitForPreview();
  assert(preview.matrixPreviewCount === 1);
  assert(preview.directOgCount === 0);
  assert.equal(preview.matrixRequest.authenticated, true);
  assert.equal(preview.matrixRequest.method, 'GET');
  assert.equal(new URL(preview.matrixRequest.url).searchParams.get('url'), ogUrl);
  await client.record('network-provenance', preview);

  const finalEncryption = await fixtures.roomState(
    account,
    room.id,
    'm.room.encryption',
  );
  assert.equal(finalEncryption, undefined, 'Link-preview Room stayed plaintext');
  await client.record('plaintext-final', {
    encryptionStateAbsent: finalEncryption === undefined,
  });
}

const cases: readonly LinkPreviewCase[] = [
  {
    id: 'link-preview',
    source: `${LINK_PREVIEW_SOURCES.definition}; ${LINK_PREVIEW_SOURCES.ogUrl}; ${LINK_PREVIEW_SOURCES.caddy}; ${LINK_PREVIEW_SOURCES.app}; ${LINK_PREVIEW_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one link-preview stage exists');
assert.equal(allAssertionIds.length, LINK_PREVIEW_ASSERTION_RECORDS);

void test(
  'Android link-preview journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'link-preview',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[`PASSWORD_${account.username}`] = account.password;
            return account;
          },
        };
        matrixResources.cleanup('Scan link-preview diagnostics', () =>
          scanLinkPreviewArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact link-preview diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<LinkPreviewAssertion>();
        const records = new Set<LinkPreviewAssertion>();
        const stages: Array<{
          readonly id: LinkPreviewCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 3;
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
                expectedUniqueAssertions: 3,
                expectedAssertionRecords: 3,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: LINK_PREVIEW_SOURCES,
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
        matrixResources.cleanup('Link-preview Android device', () =>
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
          let observer: LinkPreviewNetworkObserver | undefined;
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: 3,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[link-preview] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runLinkPreviewStage({
              client,
              fixtures,
              signal,
              secrets,
              unique,
              records,
              setObserver(value) {
                observer = value;
              },
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 3);
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            if (observer) {
              try {
                await observer.close();
              } catch (error) {
                failures.push(error);
              }
            }
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
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
              `[link-preview] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Link-preview journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 3);
        assert.equal(records.size, LINK_PREVIEW_ASSERTION_RECORDS);
      },
    );
  },
);
