import { dialog, type IpcMain } from 'electron';
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import {
  describeTrainingFiles,
  readTrainingDownload,
} from './training-archive';

/** Desktop presentation adapter; the authenticated backend download API stays unchanged. */
export default function registerTrainingMaterialsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  download: (day: unknown) => Promise<unknown>,
) {
  ipc.handle('study-task-materials', async (_event, day: unknown) =>
    describeTrainingFiles(await readTrainingDownload(await download(day))),
  );
  ipc.handle('study-save-references', async (_event, day: unknown) => {
    const files = await readTrainingDownload(await download(day));
    const instruction = describeTrainingFiles(files).documents[0]?.id;
    const references = files.filter((file) => file.name !== instruction);
    if (!references.length) return { empty: true };
    const destination = await dialog.showSaveDialog({
      title: 'Save all reference files',
      defaultPath: `day-${day}-references.zip`,
    });
    if (destination.canceled || !destination.filePath)
      return { canceled: true };
    const zip = new JSZip();
    references.forEach((file) => zip.file(file.name, file.data));
    const data = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
    await fs.writeFile(destination.filePath, data);
    return { success: true };
  });
  ipc.handle(
    'study-save-reference',
    async (_event, day: unknown, fileId: unknown) => {
      if (typeof fileId !== 'string')
        throw new Error('Invalid reference file.');
      const files = await readTrainingDownload(await download(day));
      const file = files.find((item) => item.name === fileId);
      if (!file)
        throw new Error(
          'This reference is no longer available. Reopen the task to refresh its files.',
        );
      const destination = await dialog.showSaveDialog({
        title: 'Save reference file',
        defaultPath: path.posix.basename(file.name),
      });
      if (destination.canceled || !destination.filePath)
        return { canceled: true };
      await fs.writeFile(destination.filePath, file.data);
      return { success: true };
    },
  );
}
