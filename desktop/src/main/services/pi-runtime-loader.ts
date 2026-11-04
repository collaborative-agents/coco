import { pathToFileURL } from 'url';

// Keep the native ESM SDK outside the Electron webpack bundle.
export async function loadPiRuntime(runtimePath: string) {
  return import(/* webpackIgnore: true */ pathToFileURL(runtimePath).href);
}
