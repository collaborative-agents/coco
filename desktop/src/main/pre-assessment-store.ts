import fs from 'fs';
import path from 'path';
import type { IpcMain } from 'electron';
import {
  SET_A_QUESTIONS,
  type PreAssessmentResult,
  type PreAssessmentSet,
  type PreAssessmentState,
  type SetAAnswers,
  type SetEAnswers,
} from '../shared/pre-assessment';

interface StoredAssessments {
  version: 1;
  users: Record<string, PreAssessmentState>;
}

interface PreAssessmentGateway {
  requestJson(
    route: string,
    method: 'GET' | 'POST',
    body?: object,
  ): Promise<Record<string, unknown>>;
}

const emptyState = (): PreAssessmentState => ({
  complete: false,
  sets: { A: null, E: null },
});

const storePath = (userDataPath: string) =>
  path.join(userDataPath, 'pre-assessments.json');

function readStore(userDataPath: string): StoredAssessments {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(userDataPath), 'utf8'));
    if (
      parsed?.version === 1 &&
      parsed?.users &&
      typeof parsed.users === 'object'
    )
      return parsed as StoredAssessments;
  } catch {
    // A missing or invalid store safely means the participant has not finished.
  }
  return { version: 1, users: {} };
}

function writeStore(userDataPath: string, store: StoredAssessments): void {
  const destination = storePath(userDataPath);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, destination);
}

function writeState(
  userDataPath: string,
  userId: string,
  state: PreAssessmentState,
): void {
  const store = readStore(userDataPath);
  store.users[userId] = state;
  writeStore(userDataPath, store);
}

function resultFromServer(
  raw: unknown,
  expectedSet: PreAssessmentSet,
): PreAssessmentResult {
  if (!raw || typeof raw !== 'object')
    throw new Error('The study server returned an invalid assessment result.');
  const candidate = raw as Record<string, unknown>;
  const responses = candidate.responses;
  if (
    candidate.set !== expectedSet ||
    !Number.isInteger(candidate.score) ||
    !Number.isInteger(candidate.max_score) ||
    typeof candidate.completed_at !== 'string' ||
    !responses ||
    typeof responses !== 'object'
  )
    throw new Error('The study server returned an invalid assessment result.');
  return {
    set: expectedSet,
    score: Number(candidate.score),
    maxScore: Number(candidate.max_score),
    completedAt: candidate.completed_at,
    answers: responses as SetAAnswers | SetEAnswers,
  };
}

function stateFromServer(raw: unknown): PreAssessmentState {
  if (!raw || typeof raw !== 'object')
    throw new Error('The study server returned invalid assessment progress.');
  const candidate = raw as Record<string, unknown>;
  const sets = candidate.sets as Record<string, unknown> | undefined;
  if (!sets || typeof sets !== 'object')
    throw new Error('The study server returned invalid assessment progress.');
  const state: PreAssessmentState = {
    complete: false,
    sets: {
      A: sets.A ? resultFromServer(sets.A, 'A') : null,
      E: sets.E ? resultFromServer(sets.E, 'E') : null,
    },
  };
  state.complete = Boolean(state.sets.A && state.sets.E);
  return state;
}

const submissionBody = (result: PreAssessmentResult) => ({
  responses: result.answers,
  score: result.score,
  max_score: result.maxScore,
});

export async function syncPreAssessmentState(
  userDataPath: string,
  userId: string,
  client: PreAssessmentGateway,
): Promise<PreAssessmentState> {
  const local = readPreAssessmentState(userDataPath, userId);
  // Backfill results created before server persistence was introduced.
  for (const set of ['A', 'E'] as const) {
    const result = local.sets[set];
    if (result)
      await client.requestJson(
        `/api/study/pre-assessments/${set}`,
        'POST',
        submissionBody(result),
      );
  }
  const remote = stateFromServer(
    await client.requestJson('/api/study/pre-assessments', 'GET'),
  );
  writeState(userDataPath, userId, remote);
  return remote;
}

export function readPreAssessmentState(
  userDataPath: string,
  userId: string | null,
): PreAssessmentState {
  if (!userId) return emptyState();
  const state = readStore(userDataPath).users[userId];
  if (!state) return emptyState();
  return {
    complete: Boolean(state.sets?.A && state.sets?.E),
    sets: {
      A: state.sets?.A ?? null,
      E: state.sets?.E ?? null,
    },
  };
}

export function arePreAssessmentsComplete(
  userDataPath: string,
  userId: string | null,
): boolean {
  return readPreAssessmentState(userDataPath, userId).complete;
}

function scoreSetA(raw: unknown): { answers: SetAAnswers; score: number } {
  if (!raw || typeof raw !== 'object')
    throw new Error('Please answer every question.');
  const answers = raw as SetAAnswers;
  const valid = SET_A_QUESTIONS.every((question) =>
    question.options.some(
      (option) => option.id === answers[String(question.id)],
    ),
  );
  if (!valid) throw new Error('Please answer every question.');
  return {
    answers: Object.fromEntries(
      SET_A_QUESTIONS.map((question) => [
        String(question.id),
        answers[String(question.id)],
      ]),
    ),
    score: SET_A_QUESTIONS.filter(
      (question) => answers[String(question.id)] === question.correctAnswer,
    ).length,
  };
}

function scoreSetE(raw: unknown): { answers: SetEAnswers; score: number } {
  if (!raw || typeof raw !== 'object')
    throw new Error('Please answer every question.');
  const candidate = raw as Partial<SetEAnswers>;
  const answers: SetEAnswers = {
    e1: typeof candidate.e1 === 'string' ? candidate.e1.trim() : '',
    e2: typeof candidate.e2 === 'string' ? candidate.e2.trim() : '',
    e3: typeof candidate.e3 === 'string' ? candidate.e3.trim() : '',
  };
  if (Object.values(answers).some((answer) => answer.length < 3))
    throw new Error('Please answer every question before finishing.');

  const all = Object.values(answers).join(' ').toLowerCase();
  const source = answers.e2.toLowerCase();
  const points = [
    /state|local|jurisdiction/.test(all) &&
      /require|law|rule|differ|specific|department/.test(all),
    /minimum wage|\$?7\.25|wage/.test(all) &&
      /current|federal|state|local|department of labor|\bdol\b/.test(all),
    /benefit|health insurance|healthcare/.test(all) &&
      /state|employer size|number of employees|employee count|hours|threshold|aca/.test(
        all,
      ),
    /irs(?:\.gov)?|department of labor|dol(?:\.gov)?|state.{0,30}(?:labor|workforce|government|\.gov)|employment attorney|employment lawyer|official government/.test(
      source,
    ),
  ];
  return { answers, score: points.filter(Boolean).length };
}

export function registerPreAssessmentIpc(
  ipc: Pick<IpcMain, 'handle'>,
  userDataPath: () => string,
  currentUserId: () => string | null,
  gateway: () => PreAssessmentGateway | null,
  onCompleted: () => Promise<void> | void,
): void {
  ipc.handle('pre-assessment-state', async () => {
    const userId = currentUserId();
    if (!userId) return emptyState();
    const local = readPreAssessmentState(userDataPath(), userId);
    const client = gateway();
    if (!client) return local;
    const remote = await syncPreAssessmentState(userDataPath(), userId, client);
    await onCompleted();
    return remote;
  });
  ipc.handle(
    'pre-assessment-submit',
    async (_event, set: PreAssessmentSet, rawAnswers: unknown) => {
      const userId = currentUserId();
      if (!userId)
        throw new Error('Please sign in before taking the pre-assessment.');
      if (set !== 'A' && set !== 'E')
        throw new Error('Invalid pre-assessment set.');
      const state = readPreAssessmentState(userDataPath(), userId);
      let proposed = state.sets[set];
      if (!proposed) {
        const scored =
          set === 'A' ? scoreSetA(rawAnswers) : scoreSetE(rawAnswers);
        proposed = {
          set,
          score: scored.score,
          maxScore: set === 'A' ? 8 : 4,
          completedAt: new Date().toISOString(),
          answers: scored.answers,
        };
      }
      const client = gateway();
      if (!client)
        throw new Error('The study server is unavailable. Please try again.');
      const result = resultFromServer(
        await client.requestJson(
          `/api/study/pre-assessments/${set}`,
          'POST',
          submissionBody(proposed),
        ),
        set,
      );
      state.sets[set] = result;
      state.complete = Boolean(state.sets.A && state.sets.E);
      writeState(userDataPath(), userId, state);
      await onCompleted();
      return result;
    },
  );
}
