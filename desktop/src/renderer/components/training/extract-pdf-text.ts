/** PDF text stays on this device; the worker is bundled with the desktop app. */
export default async function extractPdfText(base64: string): Promise<string> {
  const { getDocument } = await import('./pdfjs-worker.mjs');
  const loading = getDocument({
    data: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    useSystemFonts: true,
    disableFontFace: true,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 40)
      throw new Error('This instruction PDF is too long to display.');
    const lines: string[] = [];
    let size = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      // Pages must be read in order to preserve the task's instructions.
      // eslint-disable-next-line no-await-in-loop
      const page = await pdf.getPage(number);
      // eslint-disable-next-line no-await-in-loop
      const content = await page.getTextContent();
      size += content.items.reduce(
        (total, item) => total + ('str' in item ? item.str.length : 0),
        0,
      );
      if (size > 250_000)
        throw new Error('This instruction PDF contains too much text.');
      let line = '';
      let previousY: number | null = null;
      let height = 12;
      content.items.forEach((item) => {
        if (!('str' in item)) return;
        const y = item.transform[5];
        if (previousY !== null && Math.abs(y - previousY) > 2) {
          if (line.trim()) lines.push(line.trim());
          line = '';
          if (previousY - y > height * 1.65) lines.push('');
        }
        line += item.str;
        if (item.hasEOL) {
          lines.push(line.trim());
          line = '';
        }
        previousY = y;
        height = item.height || height;
      });
      if (line.trim()) lines.push(line.trim());
      page.cleanup();
    }
    const text = lines.join('\n').trim();
    if (!text)
      throw new Error(
        'This PDF has no selectable text. Ask the study team for a text-based instruction file.',
      );
    return text;
  } finally {
    await loading.destroy();
  }
}
