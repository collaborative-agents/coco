export interface TrainingDocument {
  id: string;
  name: string;
  kind: 'pdf' | 'markdown' | 'text';
  /** Base64 for PDFs; plain UTF-8 for text and Markdown. */
  content: string;
}

export interface TrainingMaterials {
  documents: TrainingDocument[];
  files: { id: string; name: string; size: number }[];
}
