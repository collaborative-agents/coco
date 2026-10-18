import path from 'path';
import { fromBuffer, type Entry } from 'yauzl';
import type {
  TrainingMaterials,
  TrainingDocument,
} from '../../shared/training-materials';

export interface MaterialFile {
  name: string;
  data: Buffer;
}
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 60 * 1024 * 1024;
const MAX_ENTRIES = 128;

/** Read in memory only: archive paths are never extracted to the filesystem. */
export function readTrainingZip(data: Buffer): Promise<MaterialFile[]> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          reject(error ?? new Error('Invalid task ZIP.'));
          return;
        }
        const files: MaterialFile[] = [];
        const names = new Set<string>();
        let total = 0;
        let count = 0;
        let stopped = false;
        const fail = (reason: Error) => {
          if (!stopped) {
            stopped = true;
            zip.close();
            reject(reason);
          }
        };
        zip.on('error', fail);
        zip.on('end', () => {
          if (!stopped) resolve(files);
        });
        zip.on('entry', (entry: Entry) => {
          count += 1;
          if (
            count > MAX_ENTRIES ||
            entry.uncompressedSize > MAX_FILE ||
            total + entry.uncompressedSize > MAX_TOTAL
          ) {
            fail(new Error('Training ZIP is too large to preview.'));
            return;
          }
          if (
            entry.fileName.includes('\0') ||
            entry.fileName.split('/').includes('..') ||
            Math.floor(entry.externalFileAttributes / 0x10000000) === 0xa
          ) {
            fail(new Error('Unsafe path in training ZIP.'));
            return;
          }
          if (
            entry.fileName.endsWith('/') ||
            entry.fileName.startsWith('__MACOSX/') ||
            path.posix.basename(entry.fileName).startsWith('.')
          ) {
            zip.readEntry();
            return;
          }
          if (names.has(entry.fileName)) {
            fail(new Error('Duplicate file in training ZIP.'));
            return;
          }
          names.add(entry.fileName);
          total += entry.uncompressedSize;
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError ?? new Error('Cannot read training file.'));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('error', fail);
            stream.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > MAX_FILE || size > entry.uncompressedSize) {
                stream.destroy();
                fail(new Error('Training file exceeds its size limit.'));
                return;
              }
              chunks.push(chunk);
            });
            stream.on('end', () => {
              if (stopped) return;
              files.push({ name: entry.fileName, data: Buffer.concat(chunks) });
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}

export async function readTrainingDownload(
  raw: unknown,
): Promise<MaterialFile[]> {
  const file = raw as { filename?: unknown; data?: unknown } | null;
  if (
    !file ||
    typeof file.filename !== 'string' ||
    !file.filename ||
    /[\\/]/.test(file.filename) ||
    Array.from(file.filename).some(
      (character) => character.charCodeAt(0) < 32,
    ) ||
    typeof file.data !== 'string' ||
    file.data.length > 28 * 1024 * 1024
  )
    throw new Error('Invalid training file.');
  const data = Buffer.from(file.data, 'base64');
  if (!data.length || data.length > MAX_FILE)
    throw new Error('Invalid training file size.');
  if (path.extname(file.filename).toLowerCase() === '.zip')
    return readTrainingZip(data);
  return [{ name: file.filename, data }];
}

function instructionPriority(name: string) {
  if (/(^|\/)(references?|resources?|assets?)\//i.test(name)) return -10;
  if (/readme|instructions?/i.test(path.posix.basename(name))) return 3;
  if (/task|challenge|guide|day[\s_-]*\d/i.test(path.posix.basename(name)))
    return 2;
  return 0;
}

export function describeTrainingFiles(
  files: MaterialFile[],
): TrainingMaterials {
  const documents: TrainingDocument[] = [];
  files.forEach((file) => {
    const extension = path.extname(file.name).toLowerCase();
    let kind: TrainingDocument['kind'] | null = null;
    if (extension === '.pdf' && file.data.subarray(0, 5).toString() === '%PDF-')
      kind = 'pdf';
    else if (['.md', '.markdown'].includes(extension)) kind = 'markdown';
    else if (extension === '.txt') kind = 'text';
    if (kind)
      documents.push({
        id: file.name,
        name: file.name,
        kind,
        content: file.data.toString(kind === 'pdf' ? 'base64' : 'utf8'),
      });
  });
  documents.sort(
    (a, b) =>
      instructionPriority(b.name) - instructionPriority(a.name) ||
      a.name.localeCompare(b.name),
  );
  return {
    documents,
    files: files.map((file) => ({
      id: file.name,
      name: file.name,
      size: file.data.length,
    })),
  };
}
