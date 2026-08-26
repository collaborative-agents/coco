import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clearAuthSession,
  readAuthSession,
  saveAuthSession,
} from './auth-session-store';

describe('study auth session store', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-auth-test-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('persists and clears a keep-signed-in token with private permissions', () => {
    const session = {
      token: 'token-1',
      participantId: 'participant-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    saveAuthSession(directory, session);

    expect(readAuthSession(directory)).toEqual(session);
    expect(
      fs.statSync(path.join(directory, 'coco-study-auth-session.json')).mode %
        0o1000,
    ).toBe(0o600);

    clearAuthSession(directory);
    expect(readAuthSession(directory)).toBeNull();
  });

  it('does not restore an expired token', () => {
    saveAuthSession(directory, {
      token: 'expired-token',
      participantId: 'participant-1',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(readAuthSession(directory)).toBeNull();
  });
});
