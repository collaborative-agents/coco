/** @jest-environment node */
import { deflateRawSync } from 'zlib';
import {
  describeTrainingFiles,
  readTrainingDownload,
  readTrainingZip,
} from './training-archive';

function zipFixture(
  entries: { name: string; text: string; size?: number; attributes?: number }[],
) {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  entries.forEach((entry) => {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.text);
    const packed = deflateRawSync(data);
    let crc = 0xffffffff;
    data.forEach((byte) => {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    });
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(entry.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(entry.size ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.attributes ?? 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + packed.length;
  });
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

it('previews instructions from a ZIP and lists references without extracting paths', async () => {
  const data = zipFixture([
    { name: 'references/data.csv', text: 'name,value\nA,10' },
    { name: 'references/report.pdf', text: '%PDF-1.4 reference' },
    { name: 'Day 1/README.md', text: '# Task\nTry one prompt.' },
    { name: '__MACOSX/._README.md', text: 'metadata' },
  ]);
  const files = await readTrainingDownload({
    filename: 'day1.zip',
    data: data.toString('base64'),
  });
  const result = describeTrainingFiles(files);
  expect(result.documents[0]).toMatchObject({
    name: 'Day 1/README.md',
    kind: 'markdown',
    content: '# Task\nTry one prompt.',
  });
  expect(result.files).toHaveLength(3);
  expect(files[0].data.toString()).toBe('name,value\nA,10');
});

it('supports standalone PDFs and distinguishes text from unsupported documents', async () => {
  const files = await readTrainingDownload({
    filename: 'task.pdf',
    data: Buffer.from('%PDF-1.4 task').toString('base64'),
  });
  expect(describeTrainingFiles(files).documents[0].kind).toBe('pdf');
  const result = describeTrainingFiles([
    { name: 'notes.txt', data: Buffer.from('Read me') },
    { name: 'fake.pdf', data: Buffer.from('<script>bad</script>') },
    { name: 'template.xlsx', data: Buffer.from('file') },
  ]);
  expect(result.documents).toEqual([
    { id: 'notes.txt', name: 'notes.txt', kind: 'text', content: 'Read me' },
  ]);
  expect(result.files).toHaveLength(3);
});

it.each(['../escape.txt', '/absolute.txt', 'C:\\escape.txt'])(
  'rejects unsafe archive paths: %s',
  async (name) => {
    await expect(
      readTrainingZip(zipFixture([{ name, text: 'unsafe' }])),
    ).rejects.toThrow();
  },
);

it('rejects symlinks, duplicate names, oversized entries, and invalid ZIP data', async () => {
  await expect(
    readTrainingZip(
      zipFixture([
        { name: 'link', text: 'target', attributes: (0xa000 << 16) >>> 0 },
      ]),
    ),
  ).rejects.toThrow('Unsafe path');
  await expect(
    readTrainingZip(
      zipFixture([
        { name: 'same.txt', text: 'a' },
        { name: 'same.txt', text: 'b' },
      ]),
    ),
  ).rejects.toThrow('Duplicate');
  await expect(
    readTrainingZip(
      zipFixture([{ name: 'huge.txt', text: 'small', size: 21 * 1024 * 1024 }]),
    ),
  ).rejects.toThrow('too large');
  await expect(readTrainingZip(Buffer.from('not a ZIP'))).rejects.toThrow();
});

it('rejects excessive entry counts and expanded-size mismatches', async () => {
  await expect(
    readTrainingZip(
      zipFixture(
        Array.from({ length: 129 }, (_, index) => ({
          name: `entry-${index}.txt`,
          text: 'x',
        })),
      ),
    ),
  ).rejects.toThrow('too large');
  await expect(
    readTrainingZip(
      zipFixture([
        { name: 'mismatch.txt', text: 'bigger than declared', size: 1 },
      ]),
    ),
  ).rejects.toThrow();
});

it.each([
  null,
  { filename: '../task.pdf', data: 'a' },
  { filename: 'task.pdf', data: '' },
])('rejects malformed download responses', async (raw) => {
  await expect(readTrainingDownload(raw)).rejects.toThrow('Invalid training');
});
