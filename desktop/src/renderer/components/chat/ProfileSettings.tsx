import type React from 'react';
import { S } from './styles';
import { CHATBOTS, AGENTS, MODE_OPTIONS } from './constants';

interface Props {
  editHideAvatar: boolean;
  avatarSaving: boolean;
  updateAvatarVisibility: (hideAvatar: boolean) => Promise<void>;
  avatarSaveError: string;
  supportedModes: (
    | 'student_learning'
    | 'everyday_support'
    | 'ai_upskilling'
    | 'custom'
  )[];
  editScenario: string;
  setEditScenario: React.Dispatch<React.SetStateAction<string>>;
  editTools: string[];
  toggleEditTool: (id: string) => void;
  customLabel: (id: string) => string;
  setShowAddChatbot: React.Dispatch<React.SetStateAction<boolean>>;
  showAddChatbot: boolean;
  cbName: string;
  setCbName: React.Dispatch<React.SetStateAction<string>>;
  cbUrl: string;
  setCbUrl: React.Dispatch<React.SetStateAction<string>>;
  cbDesc: string;
  setCbDesc: React.Dispatch<React.SetStateAction<string>>;
  addCustomChatbot: () => void;
  setShowAddAgent: React.Dispatch<React.SetStateAction<boolean>>;
  showAddAgent: boolean;
  agName: string;
  setAgName: React.Dispatch<React.SetStateAction<string>>;
  agDesc: string;
  setAgDesc: React.Dispatch<React.SetStateAction<string>>;
  addCustomAgent: () => void;
  dirty: boolean;
  saveSettings: () => Promise<void>;
  savedFlash: boolean;
}

export default function ProfileSettings({
  editHideAvatar,
  avatarSaving,
  updateAvatarVisibility,
  avatarSaveError,
  supportedModes,
  editScenario,
  setEditScenario,
  editTools,
  toggleEditTool,
  customLabel,
  setShowAddChatbot,
  showAddChatbot,
  cbName,
  setCbName,
  cbUrl,
  setCbUrl,
  cbDesc,
  setCbDesc,
  addCustomChatbot,
  setShowAddAgent,
  showAddAgent,
  agName,
  setAgName,
  agDesc,
  setAgDesc,
  addCustomAgent,
  dirty,
  saveSettings,
  savedFlash,
}: Props) {
  return (
    <section className="workspace-settings-section">
      <div style={S.groupLabel}>Desktop</div>
      <label style={S.toggleRow} htmlFor="hide-desktop-avatar">
        <input
          id="hide-desktop-avatar"
          type="checkbox"
          checked={editHideAvatar}
          disabled={avatarSaving}
          onChange={(e) => void updateAvatarVisibility(e.target.checked)}
        />
        <span>
          <strong style={S.toggleTitle}>Hide desktop avatar</strong>
          <span style={S.toggleHelp}>
            Keep Coco in the system tray and show proactive suggestions as
            notifications.
          </span>
        </span>
      </label>
      {avatarSaving && (
        <div style={{ ...S.helpText, marginTop: -8 }}>Applying…</div>
      )}
      {avatarSaveError && (
        <div
          style={{
            color: 'var(--coco-color-danger)',
            fontSize: 'var(--coco-text-secondary)',
            margin: '-8px 0 12px',
          }}
        >
          {avatarSaveError}
        </div>
      )}

      <div style={S.sectionDivider} />

      <div style={S.groupLabel}>Agent mode</div>
      <div style={S.chips}>
        {MODE_OPTIONS.filter((mode) => supportedModes.includes(mode.id)).map(
          (m) => (
            <button
              key={m.id}
              type="button"
              style={{ ...S.chip, ...(editScenario === m.id ? S.chipOn : {}) }}
              onClick={() => setEditScenario(m.id)}
            >
              {m.label}
            </button>
          ),
        )}
      </div>

      <div style={S.groupLabel}>AI Chatbots</div>
      <div style={S.chips}>
        {CHATBOTS.map((t) => (
          <button
            key={t.id}
            type="button"
            style={{ ...S.chip, ...(editTools.includes(t.id) ? S.chipOn : {}) }}
            onClick={() => toggleEditTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        {/* Any custom chatbots already added */}
        {editTools
          .filter((id) => id.startsWith('custom_chatbot:'))
          .map((id) => (
            <button
              key={id}
              type="button"
              style={{ ...S.chip, ...S.chipOn }}
              title="Click to remove"
              onClick={() => toggleEditTool(id)}
            >
              {customLabel(id)} ✕
            </button>
          ))}
        <button
          type="button"
          style={{ ...S.chip, ...S.chipDashed }}
          onClick={() => setShowAddChatbot((v) => !v)}
        >
          + Custom
        </button>
      </div>
      {showAddChatbot && (
        <div style={S.customForm}>
          <input
            style={S.customInput}
            placeholder="Name — e.g. DeepSeek"
            value={cbName}
            onChange={(e) => setCbName(e.target.value)}
          />
          <input
            style={S.customInput}
            placeholder="Website URL — e.g. https://chat.deepseek.com/"
            value={cbUrl}
            onChange={(e) => setCbUrl(e.target.value)}
          />
          <input
            style={S.customInput}
            placeholder="Description (optional) — what it's good at"
            value={cbDesc}
            onChange={(e) => setCbDesc(e.target.value)}
          />
          <button type="button" style={S.addBtn} onClick={addCustomChatbot}>
            Add chatbot
          </button>
        </div>
      )}

      <div style={S.groupLabel}>AI Agents</div>
      <div style={S.chips}>
        {AGENTS.map((t) => (
          <button
            key={t.id}
            type="button"
            style={{ ...S.chip, ...(editTools.includes(t.id) ? S.chipOn : {}) }}
            onClick={() => toggleEditTool(t.id)}
          >
            {t.label}
          </button>
        ))}
        {editTools
          .filter((id) => id.startsWith('custom_agent:'))
          .map((id) => (
            <button
              key={id}
              type="button"
              style={{ ...S.chip, ...S.chipOn }}
              title="Click to remove"
              onClick={() => toggleEditTool(id)}
            >
              {customLabel(id)} ✕
            </button>
          ))}
        <button
          type="button"
          style={{ ...S.chip, ...S.chipDashed }}
          onClick={() => setShowAddAgent((v) => !v)}
        >
          + Custom
        </button>
      </div>
      {showAddAgent && (
        <div style={S.customForm}>
          <input
            style={S.customInput}
            placeholder="Name — e.g. internal automation tool"
            value={agName}
            onChange={(e) => setAgName(e.target.value)}
          />
          <input
            style={S.customInput}
            placeholder="Description (optional) — what it does"
            value={agDesc}
            onChange={(e) => setAgDesc(e.target.value)}
          />
          <button type="button" style={S.addBtn} onClick={addCustomAgent}>
            Add agent
          </button>
        </div>
      )}

      <div style={S.saveRow}>
        <button
          type="button"
          style={{ ...S.saveBtn, ...(dirty ? {} : S.sendBtnDisabled) }}
          onClick={saveSettings}
          disabled={!dirty}
        >
          Save changes
        </button>
        {savedFlash && <span style={S.saved}>✓ Saved &amp; applied</span>}
      </div>
    </section>
  );
}
