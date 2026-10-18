import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execute, retry } from './retry-command.mjs';

export function submissionId(record) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(record.id || '')) {
    throw new Error('Apple did not return a valid notarization submission ID');
  }
  return record.id;
}

export function assertAccepted(record) {
  if (record.status !== 'Accepted') {
    throw new Error(
      `Notarization was not accepted: ${record.status || 'missing status'}`,
    );
  }
}

export async function notarize(mode, archive, receipt, run = execute) {
  const credentials = [
    '--key',
    process.env.APPLE_API_KEY,
    '--key-id',
    process.env.APPLE_API_KEY_ID,
    '--issuer',
    process.env.APPLE_API_ISSUER,
  ];
  if (credentials.some((value) => !value))
    throw new Error('Missing Apple API credentials');
  if (mode === 'submit') {
    // Save the ID before waiting so a later job attempt can resume this submission.
    const output = await retry(() =>
      run('xcrun', [
        'notarytool',
        'submit',
        archive,
        ...credentials,
        '--output-format',
        'json',
      ]),
    );
    const record = JSON.parse(output);
    submissionId(record);
    writeFileSync(receipt, JSON.stringify(record));
  } else if (mode === 'wait') {
    const id = submissionId(JSON.parse(readFileSync(receipt, 'utf8')));
    try {
      const output = await retry(() =>
        run('xcrun', [
          'notarytool',
          'wait',
          id,
          ...credentials,
          '--timeout',
          '20m',
          '--output-format',
          'json',
        ]),
      );
      assertAccepted(JSON.parse(output));
    } catch (error) {
      // Apple's log explains actual signing/validation failures. Preserve the
      // original failure if the log endpoint is also unavailable.
      try {
        await run('xcrun', ['notarytool', 'log', id, ...credentials]);
      } catch {}
      throw error;
    }
  } else {
    throw new Error(`Unknown notarization mode: ${mode}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await notarize(...process.argv.slice(2));
}
