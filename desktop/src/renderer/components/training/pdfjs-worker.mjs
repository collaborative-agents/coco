import {
  getDocument,
  GlobalWorkerOptions,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

// Legacy bundles include the polyfills needed by the app's Electron Chromium version.
GlobalWorkerOptions.workerPort = new Worker(
  new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url),
  { type: 'module' },
);

export { getDocument };
