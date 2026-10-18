// Narrow declarations for our PDF.js worker adapter, which only extracts text.
export function getDocument(options: {
  data: Uint8Array;
  useSystemFonts: boolean;
  disableFontFace: boolean;
}): {
  promise: Promise<{
    numPages: number;
    getPage(number: number): Promise<{
      getTextContent(): Promise<{
        items: (
          | {
              str: string;
              transform: number[];
              height: number;
              hasEOL: boolean;
            }
          | { type: string }
        )[];
      }>;
      cleanup(): void;
    }>;
  }>;
  destroy(): Promise<void>;
};
