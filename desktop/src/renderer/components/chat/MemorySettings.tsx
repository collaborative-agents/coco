import type React from 'react';
import { S } from './styles';

interface Props {
  memoryDraft: string;
  setMemoryDraft: React.Dispatch<React.SetStateAction<string>>;
  memoryDirty: boolean;
  saveMemory: () => Promise<void>;
  memoryFlash: boolean;
}

export default function MemorySettings({
  memoryDraft,
  setMemoryDraft,
  memoryDirty,
  saveMemory,
  memoryFlash,
}: Props) {
  return (
    <section
      className="workspace-settings-section"
      aria-labelledby="memory-heading"
    >
      <h2 id="memory-heading" className="settings-heading">
        Memory
      </h2>
      <div style={S.helpText}>
        Preferences and notes Coco uses in each conversation. Edit them anytime.
      </div>
      <textarea
        aria-label="Memory"
        style={S.memoryArea}
        placeholder="e.g. Prefers concise answers. Works mostly in Google Docs and Slides. Comfortable with Claude; new to agents."
        value={memoryDraft}
        onChange={(e) => setMemoryDraft(e.target.value)}
      />
      <div style={S.saveRow}>
        <button
          type="button"
          style={{ ...S.saveBtn, ...(memoryDirty ? {} : S.sendBtnDisabled) }}
          onClick={saveMemory}
          disabled={!memoryDirty}
        >
          Save memory
        </button>
        {memoryFlash && <span style={S.saved}>✓ Saved</span>}
      </div>
    </section>
  );
}
