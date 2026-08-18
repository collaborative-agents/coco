import fs from 'fs';
import path from 'path';

export interface StoredAuthSession {
  token: string;
  participantId: string;
  expiresAt: string;
}

const authSessionPath = (userDataPath: string): string =>
  path.join(userDataPath, 'coco-auth-session.json');

export const readAuthSession = (
  userDataPath: string,
): StoredAuthSession | null => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(authSessionPath(userDataPath), 'utf-8'),
    ) as Partial<StoredAuthSession>;
    if (!parsed.token || !parsed.participantId || !parsed.expiresAt)
      return null;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) return null;
    return {
      token: parsed.token,
      participantId: parsed.participantId,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
};

export const saveAuthSession = (
  userDataPath: string,
  session: StoredAuthSession,
): void => {
  const destination = authSessionPath(userDataPath);
  const temporary = `${destination}.tmp`;
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(session, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
};

export const clearAuthSession = (userDataPath: string): void => {
  try {
    fs.unlinkSync(authSessionPath(userDataPath));
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
};
