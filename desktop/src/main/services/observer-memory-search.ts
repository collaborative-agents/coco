import axios from 'axios';
import type { ObserverMemorySearchResult } from '../../shared/observer-memory';

export async function searchObserverMemory(
  question: unknown,
  sensingPort: string,
): Promise<ObserverMemorySearchResult> {
  if (
    typeof question !== 'string' ||
    !question.trim() ||
    question.length > 2000
  )
    return {
      success: false,
      error: 'Enter a question of up to 2,000 characters.',
    };
  try {
    const { data } = await axios.post(
      `http://127.0.0.1:${sensingPort}/screen-history/ask`,
      { question: question.trim() },
      { timeout: 180_000 },
    );
    if (
      typeof data.answer !== 'string' ||
      typeof data.model !== 'string' ||
      !Array.isArray(data.sources) ||
      data.sources.length > 5 ||
      data.sources.some(
        (source: any) =>
          !Number.isInteger(source.number) ||
          typeof source.time !== 'string' ||
          !Number.isFinite(source.ts) ||
          typeof source.image_url !== 'string' ||
          !/^data:image\/(jpeg|png|webp);base64,/.test(source.image_url),
      )
    )
      return {
        success: false,
        error: 'Memory search returned an invalid response. Please try again.',
      };
    return {
      success: true,
      answer: data.answer,
      model: data.model,
      sources: data.sources.map((source: any) => ({
        number: source.number,
        time: source.time,
        ts: source.ts,
        imageUrl: source.image_url,
      })),
    };
  } catch (error) {
    const detail = axios.isAxiosError(error)
      ? error.response?.data?.detail
      : null;
    return {
      success: false,
      error:
        typeof detail === 'string'
          ? detail
          : 'Memory search is unavailable. Check that Coco and your local screen-understanding model are running.',
    };
  }
}
