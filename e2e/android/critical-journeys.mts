import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { createNodeAccount } from '../support/node-account.mts';
import { createNodeEncryptedRoom } from '../support/node-encrypted-room.mts';
import { openMaestroDevice } from './maestro-session.mts';
import {
  captureAndroidSurface,
  readAndroidCryptoDatabases,
  readAndroidSurface,
  startAndroidClient,
  waitForAndroidAccount,
  waitForAndroidState,
  type AndroidApplicationId,
} from './critical-client.mts';

const primaryId = 'eu.qwky.trinity';
const secondaryId = 'eu.qwky.trinity.secondary';
const pattern = (text: string): string =>
  `(?s).*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`;

void test(
  'Android critical login, encrypted messaging, restart and foreground recovery',
  { timeout: 1_080_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR']!,
          'critical-android',
        );
        await mkdir(output, { recursive: true });
        const stages: Array<{
          name: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          error?: string;
        }> = [];
        async function stage(
          name: string,
          operation: () => Promise<void>,
        ): Promise<void> {
          const started = performance.now();
          const entry: (typeof stages)[number] = {
            name,
            status: 'running',
            durationMs: 0,
          };
          stages.push(entry);
          try {
            await operation();
            entry.status = 'passed';
          } catch (error) {
            entry.status = 'failed';
            entry.error =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            throw error;
          } finally {
            entry.durationMs = performance.now() - started;
            await writeFile(
              join(output, 'journeys.json'),
              JSON.stringify({ stages }, null, 2),
            );
          }
        }

        const primary = await createNodeAccount(
          matrixResources,
          signal,
          'primary',
        );
        const secondary = await createNodeAccount(
          matrixResources,
          signal,
          'secondary',
        );
        const room = await createNodeEncryptedRoom(
          matrixResources,
          [primary, secondary],
          signal,
        );
        const roomPath = `/rooms/${Buffer.from(room.id).toString('base64url')}`;
        assert.equal(
          (await room.readMessages()).length,
          0,
          'The fixture has no seeded messages',
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Critical Android device', () =>
          device.close(),
        );
        let active:
          | (Awaited<ReturnType<typeof startAndroidClient>> & {
              applicationId: AndroidApplicationId;
            })
          | undefined;
        matrixResources.cleanup('Active critical WebView', async () => {
          await active?.webview.close();
        });

        async function activate(
          applicationId: AndroidApplicationId,
        ): Promise<void> {
          if (active) {
            await active.webview.close();
            await device.adb('shell', 'am', 'force-stop', active.applicationId);
            active = undefined;
          }
          // Serial clients have independent native stores. No inactive WebView may
          // participate in Maestro observations or the TLS diagnostic attachment.
          for (const id of [primaryId, secondaryId])
            await device.adb('shell', 'am', 'force-stop', id);
          active = {
            ...(await startAndroidClient(device, applicationId, signal)),
            applicationId,
          };
        }
        function current(): NonNullable<typeof active> {
          assert(active, 'An Android client must be active');
          return active;
        }
        async function flow(
          name: string,
          variables: Readonly<Record<string, string>> = {},
        ): Promise<void> {
          await device.runFlow(
            join(
              session.workspaceRoot,
              `e2e/android/flows/critical-${name}.yaml`,
            ),
            {
              APP_ID: current().applicationId,
              ...variables,
            },
          );
        }
        async function accountReady(account: typeof primary): Promise<void> {
          await waitForAndroidState(
            () => readAndroidSurface(current().webview),
            (surface) =>
              new URL(surface.url).searchParams.get('account') ===
                `@${account.username}:localhost` &&
              new URL(surface.url).pathname.startsWith('/rooms'),
            `authenticated ${account.username} Rooms`,
            signal,
          );
        }
        async function openRoom(): Promise<void> {
          const surface = await readAndroidSurface(current().webview);
          if (new URL(surface.url).pathname !== roomPath) {
            await flow('open-room', { ROOM_PATTERN: pattern(room.name) });
          }
          await waitForAndroidState(
            () => readAndroidSurface(current().webview),
            (next) =>
              new URL(next.url).pathname === roomPath && next.composer !== null,
            'the encrypted room composer',
            signal,
          );
        }
        async function readMessage(body: string): Promise<string> {
          const surface = await waitForAndroidState(
            () => readAndroidSurface(current().webview),
            (value) =>
              value.messages.some(
                (message) =>
                  message.body === body && message.id.startsWith('$'),
              ),
            `decrypted message: ${body}`,
            signal,
          );
          await flow('read', { MESSAGE_PATTERN: pattern(body) });
          const message = surface.messages.find((value) => value.body === body);
          assert(message);
          const expected = events.find((event) => event.body === body);
          if (expected)
            assert.equal(
              message.id,
              expected.id,
              'The recipient decrypts the same client-generated event',
            );
          return message.id;
        }
        async function sendMessage(
          body: string,
          unicode = false,
        ): Promise<string> {
          await flow(unicode ? 'compose-unicode' : 'compose', {
            MESSAGE: body,
          });
          assert.equal(
            (await readAndroidSurface(current().webview)).composer,
            body,
            'Native input preserves the exact message',
          );
          await flow('send');
          return readMessage(body);
        }
        const identities = new Map<
          AndroidApplicationId,
          Awaited<ReturnType<typeof waitForAndroidAccount>>
        >();
        async function identity(account: typeof primary): Promise<void> {
          const client = current();
          const observed = await waitForAndroidAccount(
            device,
            client.applicationId,
            `@${account.username}:localhost`,
            signal,
          );
          if (identities.has(client.applicationId))
            assert.deepEqual(
              observed,
              identities.get(client.applicationId),
              'Process restart restores the same account and crypto identity',
            );
          else identities.set(client.applicationId, observed);
          const database = `${observed.cryptoPrefix}::matrix-sdk-crypto`;
          await waitForAndroidState(
            () => readAndroidCryptoDatabases(client.webview),
            (databases) => databases.includes(database),
            'the account-owned Rust crypto database',
            signal,
          );
        }
        const events: Array<{ body: string; id: string; sender: string }> = [];
        async function send(
          body: string,
          account: typeof primary,
          unicode = false,
        ): Promise<void> {
          events.push({
            body,
            id: await sendMessage(body, unicode),
            sender: `@${account.username}:localhost`,
          });
        }
        async function wireProof(): Promise<void> {
          const messages = await waitForAndroidState(
            () => room.readMessages(),
            (value) =>
              events.every((event) =>
                value.some((message) => message['event_id'] === event.id),
              ),
            'client-generated Matrix wire events',
            signal,
          );
          assert.equal(
            messages.length,
            events.length,
            'Exactly the UI sends appear on the wire',
          );
          const evidence = events.map((event) => {
            const message = messages.find(
              (value) => value['event_id'] === event.id,
            );
            assert(message);
            assert.equal(message['type'], 'm.room.encrypted');
            assert.equal(message['sender'], event.sender);
            const content = message['content'];
            assert(content && typeof content === 'object');
            assert(
              'algorithm' in content &&
                content.algorithm === 'm.megolm.v1.aes-sha2',
            );
            assert(
              'ciphertext' in content &&
                typeof content.ciphertext === 'string' &&
                content.ciphertext.length > 0,
            );
            assert(
              !('body' in content),
              'Wire events must not carry plaintext bodies',
            );
            assert(
              !JSON.stringify(content).includes(event.body),
              'Wire content must not expose the composed plaintext',
            );
            return {
              eventId: event.id,
              sender: event.sender,
              type: message['type'],
              algorithm: content.algorithm,
              ciphertextPresent: true,
              plaintextBodyPresent: false,
            };
          });
          await writeFile(
            join(output, 'encrypted-events.json'),
            JSON.stringify(evidence, null, 2),
          );
        }
        const first = `B to A ${session.id}`;
        const unicode = 'Árvíztűrő 😀';
        const reply = `A to B ${session.id}`;
        const restored = `B after restart ${session.id}`;
        const recovered = `A after foreground ${session.id}`;

        try {
          await stage('login', async () => {
            await device.install(
              join(
                session.workspaceRoot,
                'android/app/build/outputs/apk/debug/app-debug.apk',
              ),
            );
            await device.install(
              join(
                session.workspaceRoot,
                'android/app/build/outputs/apk/secondaryDebug/app-secondaryDebug.apk',
              ),
              secondaryId,
            );
            for (const applicationId of [primaryId, secondaryId] as const) {
              assert.equal(
                await device.adb('shell', 'pm', 'clear', applicationId),
                'Success',
              );
              await device.adb(
                'shell',
                'pm',
                'grant',
                applicationId,
                'android.permission.POST_NOTIFICATIONS',
              );
              await activate(applicationId);
              const account = applicationId === primaryId ? primary : secondary;
              await flow('login', {
                HOMESERVER: account.homeserver,
                USERNAME: account.username,
                PASSWORD: account.password,
              });
              await accountReady(account);
              await identity(account);
              await captureAndroidSurface(
                current().webview,
                output,
                applicationId === primaryId
                  ? 'login-primary'
                  : 'login-secondary',
              );
            }
            assert.notEqual(
              identities.get(primaryId)?.cryptoPrefix,
              identities.get(secondaryId)?.cryptoPrefix,
              'The two clients own independent crypto stores',
            );
            await writeFile(
              join(output, 'identities.json'),
              JSON.stringify(Object.fromEntries(identities), null, 2),
            );
          });
          await stage('two-user-encrypted-messaging', async () => {
            await openRoom();
            await send(first, secondary);
            await send(unicode, secondary, true);
            await activate(primaryId);
            await accountReady(primary);
            await identity(primary);
            await openRoom();
            await readMessage(first);
            await readMessage(unicode);
            await send(reply, primary);
            await activate(secondaryId);
            await accountReady(secondary);
            await identity(secondary);
            await openRoom();
            await readMessage(reply);
            await wireProof();
          });
          await stage('process-restart-restoration', async () => {
            const previousPid = current().pid;
            await identity(secondary);
            await activate(secondaryId);
            assert.notEqual(
              current().pid,
              previousPid,
              'Restoration uses a new Android process',
            );
            await accountReady(secondary);
            await identity(secondary);
            await openRoom();
            await readMessage(first);
            await readMessage(unicode);
            await readMessage(reply);
            await send(restored, secondary);
            await activate(primaryId);
            await accountReady(primary);
            await identity(primary);
            await openRoom();
            await readMessage(restored);
            await wireProof();
            await captureAndroidSurface(
              current().webview,
              output,
              'after-restoration',
            );
          });
          await stage('background-foreground-recovery', async () => {
            const previousPid = current().pid;
            await flow('background');
            await waitForAndroidState(
              () => readAndroidSurface(current().webview),
              (surface) => surface.visibility === 'hidden',
              'native background visibility',
              signal,
            );
            assert.equal(
              (await device.adb('shell', 'pidof', primaryId)).trim(),
              previousPid,
              'Backgrounding preserves the process',
            );
            await device.adb(
              'shell',
              'am',
              'start',
              '-n',
              `${primaryId}/eu.qwky.trinity.MainActivity`,
            );
            await waitForAndroidState(
              () => readAndroidSurface(current().webview),
              (surface) => surface.visibility === 'visible',
              'native foreground visibility',
              signal,
            );
            assert.equal(
              (await device.adb('shell', 'pidof', primaryId)).trim(),
              previousPid,
              'Foregrounding resumes the same process',
            );
            await accountReady(primary);
            await identity(primary);
            await readMessage(restored);
            await send(recovered, primary);
            await activate(secondaryId);
            await accountReady(secondary);
            await identity(secondary);
            await openRoom();
            await readMessage(recovered);
            await wireProof();
            await captureAndroidSurface(
              current().webview,
              output,
              'after-foreground-delivery',
            );
          });
        } finally {
          if (active)
            await captureAndroidSurface(
              active.webview,
              output,
              'final-surface',
            ).catch(async (error: unknown) => {
              await writeFile(
                join(output, 'surface-unavailable.txt'),
                String(error),
              );
            });
          await writeFile(
            join(output, 'webview-version.txt'),
            await device.adb('shell', 'dumpsys', 'webviewupdate').catch(String),
          );
        }
      },
    );
  },
);
