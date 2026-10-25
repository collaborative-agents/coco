import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { app, ipcMain, shell } from 'electron';

export interface PiConnection {
  mode: 'coco' | 'native';
  provider?: string;
  model?: string;
}
const configPath = () =>
  path.join(app.getPath('userData'), 'pi-connection.json');
export function readPiConnection(): PiConnection {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (
      value.mode === 'native' &&
      typeof value.provider === 'string' &&
      typeof value.model === 'string'
    )
      return value;
  } catch {
    /* Default to the existing local bridge. */
  }
  return { mode: 'coco' };
}
let client: Promise<any> | undefined;
export function getPiClient(): Promise<any> {
  client ??= (async () => {
    const file = path.join(
      app.getAppPath(),
      ...(app.isPackaged ? [] : ['release', 'app']),
      'agent',
      'pi-auth.mjs',
    );
    const mod = await import(
      /* webpackIgnore: true */ pathToFileURL(file).href
    );
    const runtime = await mod.createModelRuntime(app.getPath('userData'));
    return {
      runtime,
      auth: mod.createAuthController(runtime, (url: string) =>
        shell.openExternal(url),
      ),
    };
  })().catch((error) => {
    client = undefined;
    throw error;
  });
  return client;
}

export async function startPiInferenceBridge(): Promise<void> {
  const file = path.join(
    app.getAppPath(),
    ...(app.isPackaged ? [] : ['release', 'app']),
    'agent',
    'pi-inference.mjs',
  );
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(file).href);
  const bridge = await mod.startInferenceBridge({
    token: process.env.COCO_PI_BRIDGE_TOKEN,
    getRuntime: async () => (await getPiClient()).runtime,
  });
  process.env.COCO_PI_INFERENCE_URL = bridge.url;
  app.once('will-quit', () => bridge.close());
}

export async function validatePiModel(
  modelId: string,
  vision = false,
): Promise<void> {
  const [, provider, ...parts] = modelId.split('/');
  const { runtime } = await getPiClient();
  const model = runtime.getModel(provider, parts.join('/'));
  if (!model || !runtime.hasConfiguredAuth(provider))
    throw new Error(
      'Connect the Pi provider and select an available model first.',
    );
  if (vision && !model.input.includes('image'))
    throw new Error('Choose a vision-capable Pi model for sensing.');
}

export function registerPiProvider(
  busy: () => boolean,
  reset: () => Promise<void>,
) {
  let owner: number | undefined;
  ipcMain.handle('pi-provider', async (event, action, payload = {}) => {
    const { runtime, auth } = await getPiClient();
    if (action === 'status')
      return { ...(await auth.status()), connection: readPiConnection() };
    if (action === 'answer' || action === 'cancel') {
      if (owner !== event.sender.id)
        throw new Error('Login belongs to another window.');
      if (action === 'answer') auth.answer(payload.id, payload.value);
      else await auth.cancel();
      return;
    }
    if (busy())
      throw new Error('Stop the current agent run before changing providers.');
    if (action === 'login') {
      auth.login(payload.provider, payload.type);
      const senderId = event.sender.id;
      if (owner !== senderId)
        event.sender.once('destroyed', () => {
          if (owner === senderId) {
            owner = undefined;
            void auth.cancel();
          }
        });
      owner = senderId;
    } else if (action === 'refresh') {
      if (!runtime.getProvider(payload.provider))
        throw new Error('Unknown provider.');
      const result = await runtime.refresh({
        providers: [payload.provider],
        allowNetwork: true,
      });
      if (result.errors.size)
        throw new Error(
          'Could not load provider models. Check your connection and try again.',
        );
    } else if (action === 'logout') {
      await auth.logout(payload.provider);
      await reset();
    } else throw new Error('Unknown provider action.');
  });
  app.on('before-quit', () => {
    if (client) void client.then(({ auth }) => auth.cancel());
  });
}
