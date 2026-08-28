import axios from 'axios';
import type { IpcMain } from 'electron';

interface HttpClient {
  post(
    url: string,
    body: object,
    config?: { timeout?: number },
  ): Promise<{ data: unknown }>;
}

type MemoryProvider = () => string;
type TutorUrlProvider = () => string;

/** Generates a local, owner-reviewed draft without touching tutor chat state. */
export default class KnowledgeAnswerService {
  private readonly memoryProvider: MemoryProvider;

  private readonly httpClient: HttpClient;

  private readonly tutorUrlProvider: TutorUrlProvider;

  constructor(
    memoryProvider: MemoryProvider,
    httpClient: HttpClient = axios,
    tutorUrlProvider: TutorUrlProvider = () =>
      `http://127.0.0.1:${process.env.TUTOR_PORT || '8081'}`,
  ) {
    this.memoryProvider = memoryProvider;
    this.httpClient = httpClient;
    this.tutorUrlProvider = tutorUrlProvider;
  }

  async draft(question: string): Promise<{ answer: string }> {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) throw new Error('Question is required.');
    const tutorUrl = this.tutorUrlProvider().replace(/\/+$/, '');
    const userMemory = this.memoryProvider();
    if (userMemory.trim()) {
      await this.httpClient.post(
        `${tutorUrl}/context/memory`,
        { memory: userMemory },
        { timeout: 8_000 },
      );
    }
    const response = await this.httpClient.post(
      `${tutorUrl}/review/knowledge-answer`,
      { question: normalizedQuestion },
      { timeout: 60_000 },
    );
    const answer = String(
      (response.data as { guidance?: unknown } | undefined)?.guidance ?? '',
    ).trim();
    if (!answer) throw new Error('The tutor returned an empty answer.');
    return { answer };
  }
}

export function registerKnowledgeAnswerIpcHandler(
  targetIpcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  service: KnowledgeAnswerService,
): void {
  targetIpcMain.removeHandler('social-draft-knowledge-answer');
  targetIpcMain.handle(
    'social-draft-knowledge-answer',
    (_event, question: string) => service.draft(question),
  );
}
