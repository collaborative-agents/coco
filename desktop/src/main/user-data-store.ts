import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export type ProfileDocument = Record<string, unknown>;

export interface TutorProfile {
  aiTools: string[];
  scenario: string;
  customObserverPrompt: string;
  userName: string;
}

export function profilePath(): string {
  return path.join(app.getPath('userData'), 'coco-profile.json');
}

export function readProfileDocument(): ProfileDocument | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(profilePath(), 'utf-8'),
    ) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as ProfileDocument)
      : null;
  } catch {
    return null;
  }
}

export function saveProfileDocument(
  profile: ProfileDocument,
  participantId?: string | null,
): void {
  fs.writeFileSync(
    profilePath(),
    JSON.stringify(
      {
        ...profile,
        ...(participantId ? { participantId } : {}),
      },
      null,
      2,
    ),
    'utf-8',
  );
}

export function updateProfileDocument(patch: ProfileDocument): ProfileDocument {
  const profile = { ...(readProfileDocument() ?? {}), ...patch };
  saveProfileDocument(profile);
  return profile;
}

export function isStoredOnboardingComplete(
  gatewayEnabled: boolean,
  participantId: string | null,
): boolean {
  const profile = readProfileDocument();
  return (
    profile?.onboardingComplete === true &&
    (!gatewayEnabled ||
      (Boolean(participantId) && profile.participantId === participantId))
  );
}

export function readHideAvatarSetting(): boolean {
  return readProfileDocument()?.hideAvatar === true;
}

export function readTutorProfile(): TutorProfile {
  let aiTools: string[] = [];
  let scenario = 'everyday_support';
  let customObserverPrompt = '';
  let userName = '';
  const profile = readProfileDocument();
  if (!profile) {
    log.warn(`[Profile] Could not read profile at ${profilePath()}.`);
    return { aiTools, scenario, customObserverPrompt, userName };
  }
  if (typeof profile.tutorScenario === 'string' && profile.tutorScenario) {
    scenario = profile.tutorScenario;
  }
  if (Array.isArray(profile.aiTools) && profile.aiTools.length > 0) {
    aiTools = profile.aiTools as string[];
  }
  if (
    typeof profile.customSystemPrompt === 'string' &&
    profile.customSystemPrompt.trim()
  ) {
    customObserverPrompt = profile.customSystemPrompt;
  }
  if (typeof profile.userName === 'string' && profile.userName.trim()) {
    userName = profile.userName.trim();
  }
  // Custom mode changes the observer prompt, but the tutor still needs a real
  // base scenario.
  if (scenario === 'custom') scenario = 'everyday_support';
  return { aiTools, scenario, customObserverPrompt, userName };
}

export function memoryPath(): string {
  return path.join(app.getPath('userData'), 'coco-memory.txt');
}

export function readLocalMemory(): string {
  try {
    return fs.readFileSync(memoryPath(), 'utf-8');
  } catch {
    return '';
  }
}

export function saveLocalMemory(memory: string): void {
  fs.writeFileSync(memoryPath(), memory, 'utf-8');
}
