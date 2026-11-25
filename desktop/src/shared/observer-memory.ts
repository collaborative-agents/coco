export interface ObserverMemorySource {
  number: number;
  time: string;
  ts: number;
  imageUrl: string;
}

export type ObserverMemorySearchResult =
  | {
      success: true;
      answer: string;
      model: string;
      sources: ObserverMemorySource[];
    }
  | { success: false; error: string };
