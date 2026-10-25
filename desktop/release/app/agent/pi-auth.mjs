import fs from 'node:fs';
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export function createModelRuntime(dataDir) {
  const dir = path.join(dataDir, 'pi');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return ModelRuntime.create({
    authPath: path.join(dir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: path.join(dir, 'models-cache.json'),
    refreshOnCreate: true,
  });
}

// Only display metadata leaves this controller. Credentials remain SDK-owned.
export function createAuthController(runtime, openExternal) {
  let flow;
  let nextPrompt = 0;
  return {
    async status() {
      return {
        providers: runtime.getProviders().map((p) => ({
          id: p.id,
          name: p.name,
          connected: runtime.hasConfiguredAuth(p.id),
          oauth: p.auth.oauth?.loginLabel || p.auth.oauth?.name,
          apiKey: p.auth.apiKey?.login ? p.auth.apiKey.name : undefined,
        })),
        models: runtime
          .getModels()
          .map((m) => ({ provider: m.provider, id: m.id, name: m.name, input: m.input })),
        flow: flow
          ? { busy: flow.busy, message: flow.message, prompt: flow.prompt }
          : null,
      };
    },
    login(provider, type) {
      if (flow?.busy)
        throw new Error('Finish or cancel the current login first.');
      const p = runtime.getProvider(provider);
      if (
        !p ||
        !(type === 'oauth'
          ? p.auth.oauth
          : type === 'api_key' && p.auth.apiKey?.login)
      )
        throw new Error('Unsupported login method.');
      const current = {
        busy: true,
        message: 'Starting login…',
        controller: new AbortController(),
      };
      flow = current;
      const timer = setTimeout(() => current.controller.abort(), 10 * 60_000);
      current.promise = runtime
        .login(provider, type, {
          signal: current.controller.signal,
          notify(event) {
            if (event.type === 'auth_url' || event.type === 'device_code') {
              const url =
                event.type === 'auth_url' ? event.url : event.verificationUri;
              if (new URL(url).protocol !== 'https:')
                throw new Error('Invalid provider login URL.');
              current.message =
                event.type === 'device_code'
                  ? `Enter code ${event.userCode} in your browser.`
                  : event.instructions || 'Complete sign-in in your browser.';
              Promise.resolve(openExternal(url)).catch(() => {
                current.message =
                  'Could not open the browser. Cancel and try again.';
              });
            } else current.message = event.message;
          },
          prompt(prompt) {
            return new Promise((resolve, reject) => {
              const signal = AbortSignal.any([
                current.controller.signal,
                ...(prompt.signal ? [prompt.signal] : []),
              ]);
              const finish = (value, error) => {
                signal.removeEventListener('abort', abort);
                current.prompt = undefined;
                current.answer = undefined;
                if (error) reject(error);
                else resolve(value);
              };
              const abort = () =>
                finish(undefined, new Error('Login cancelled.'));
              current.prompt = {
                id: ++nextPrompt,
                type: prompt.type,
                message: prompt.message,
                placeholder: prompt.placeholder,
                options: prompt.options,
              };
              current.answer = (value) => finish(value);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            });
          },
        })
        .then(async () => {
          current.message = 'Connected. Loading models…';
          try {
            const result = await runtime.refresh({
              providers: [provider],
              allowNetwork: true,
              signal: current.controller.signal,
            });
            current.message = result.errors.size
              ? 'Connected. Model discovery failed; try Refresh models.'
              : 'Connected. Choose a model below.';
          } catch {
            current.message =
              'Connected. Model discovery interrupted; try Refresh models.';
          }
        })
        .catch(() => {
          current.message = current.controller.signal.aborted
            ? 'Login cancelled.'
            : 'Login failed. Check the provider account and try again.';
        })
        .finally(() => {
          clearTimeout(timer);
          current.busy = false;
          current.prompt = undefined;
        });
    },
    answer(id, value) {
      if (!flow?.busy || flow.prompt?.id !== id || typeof value !== 'string')
        throw new Error('This login prompt has expired.');
      flow.answer(value);
    },
    async cancel() {
      flow?.controller.abort();
      await flow?.promise;
    },
    async logout(provider) {
      if (flow?.busy) throw new Error('Cancel login first.');
      await runtime.logout(provider);
    },
  };
}
