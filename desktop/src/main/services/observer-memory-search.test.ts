import axios from 'axios';
import { searchObserverMemory } from './observer-memory-search';

jest.mock('axios');
const post = axios.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

it('sends only the question to sensing and maps local screenshot evidence', async () => {
  post.mockResolvedValue({
    data: {
      answer: 'Saved detail [1]',
      model: 'local',
      sources: [
        {
          number: 1,
          time: '2026-11-24 11:14',
          ts: 100,
          image_url: 'data:image/jpeg;base64,c2NyZWVu',
        },
      ],
    },
  });
  const result = await searchObserverMemory('  What did I read? ', '49153');
  expect(post).toHaveBeenCalledWith(
    'http://127.0.0.1:49153/screen-history/ask',
    { question: 'What did I read?' },
    { timeout: 180000 },
  );
  expect(result).toEqual({
    success: true,
    answer: 'Saved detail [1]',
    model: 'local',
    sources: [
      {
        number: 1,
        time: '2026-11-24 11:14',
        ts: 100,
        imageUrl: 'data:image/jpeg;base64,c2NyZWVu',
      },
    ],
  });
});

it('rejects empty questions before contacting sensing', async () => {
  expect(await searchObserverMemory('  ', '49153')).toMatchObject({
    success: false,
  });
  expect(post).not.toHaveBeenCalled();
});

it('rejects remote screenshot URLs from a malformed response', async () => {
  post.mockResolvedValue({
    data: {
      answer: 'Answer',
      model: 'local',
      sources: [
        {
          number: 1,
          time: 'now',
          ts: 100,
          image_url: 'https://example.com/private.png',
        },
      ],
    },
  });
  expect(await searchObserverMemory('Question', '49153')).toMatchObject({
    success: false,
  });
});

it('preserves the actionable local-model setup error', async () => {
  (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  post.mockRejectedValue({
    response: {
      data: {
        detail: 'Choose a local screen-understanding model in Settings.',
      },
    },
  });
  expect(await searchObserverMemory('Question', '49153')).toEqual({
    success: false,
    error: 'Choose a local screen-understanding model in Settings.',
  });
});
