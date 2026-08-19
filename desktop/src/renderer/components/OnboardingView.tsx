import { useEffect, useState } from 'react';
import { encodeCustomChatbot, encodeCustomAgent } from './observation-types';
import './OnboardingView.css';
import foxWorking from '../../../assets/pet1.png';
import foxWaiting from '../../../assets/wait1.png';
import studentLearningIcon from '../../../assets/student_learning.png';
import everydaySupportIcon from '../../../assets/everyday_support.png';
import customModeIcon from '../../../assets/custom.png';

// Platform-appropriate label for the global screen-capture hot key
// (registered in main.ts as CommandOrControl+Shift+Space).
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
const HOTKEY_LABEL = IS_MAC ? 'Cmd + Shift + Space' : 'Ctrl + Shift + Space';

const MODEL_PROVIDERS = [
  ['gemini', 'Google Gemini'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['tinker', 'Tinker'],
  ['tinfoil', 'Tinfoil (confidential)'],
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio (local)'],
] as const;
const ENDPOINT_PROVIDERS = new Set(['hosted_vllm', 'lm_studio']);

interface ModelDraft {
  id: string;
  label: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
}

interface ConnectionTestStatus {
  state: 'testing' | 'success' | 'error';
  message: string;
}

function ModelFields({
  value,
  onChange,
  sensing = false,
  onTest,
  testStatus,
}: {
  value: ModelDraft;
  onChange: (next: ModelDraft) => void;
  sensing?: boolean;
  onTest: () => void;
  testStatus?: ConnectionTestStatus;
}) {
  const update = (field: keyof ModelDraft, next: string) =>
    onChange({ ...value, [field]: next });
  let modelPlaceholder = sensing
    ? 'Vision model ID (provider/model)'
    : 'Model ID (provider/model)';
  if (value.provider === 'hosted_vllm') {
    modelPlaceholder = 'Exact model ID returned by /v1/models';
  }
  return (
    <div className="ob-model-card">
      <div className="ob-model-card-title">
        {sensing ? 'Sensitive sensing model' : value.label || 'Tutor model'}
      </div>
      {sensing && (
        <div className="ob-model-warning">
          This model receives screenshots. Choose a vision-capable model and a
          provider you trust.
        </div>
      )}
      {!sensing && (
        <input
          className="ob-custom-input"
          value={value.label}
          placeholder="Display name, e.g. Claude Sonnet"
          onChange={(event) => update('label', event.target.value)}
        />
      )}
      <select
        className="ob-custom-input"
        value={value.provider}
        onChange={(event) => update('provider', event.target.value)}
      >
        {MODEL_PROVIDERS.map(([id, label]) => (
          <option key={id} value={id}>{label}</option>
        ))}
      </select>
      <input
        className="ob-custom-input"
        value={value.model}
        placeholder={modelPlaceholder}
        onChange={(event) => update('model', event.target.value)}
      />
      {ENDPOINT_PROVIDERS.has(value.provider) && (
        <input
          className="ob-custom-input"
          value={value.baseUrl}
          placeholder={value.provider === 'lm_studio' ? 'Host (default localhost:1234)' : 'OpenAI-compatible base URL, ending in /v1'}
          onChange={(event) => update('baseUrl', event.target.value)}
        />
      )}
      {value.provider !== 'lm_studio' && (
        <input
          className="ob-custom-input"
          type="password"
          value={value.apiKey}
          placeholder={value.provider === 'hosted_vllm' ? 'API key (optional)' : 'API key'}
          autoComplete="off"
          onChange={(event) => update('apiKey', event.target.value)}
        />
      )}
      <div className="ob-connection-test-row">
        <button
          type="button"
          className="ob-connection-test-btn"
          disabled={testStatus?.state === 'testing'}
          onClick={onTest}
        >
          {testStatus?.state === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {testStatus?.state === 'success' && (
          <span className="ob-connection-test-success">{testStatus.message}</span>
        )}
        {testStatus?.state === 'error' && (
          <details className="ob-connection-test-error">
            <summary>Connection failed — show details</summary>
            <pre>{testStatus.message}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function StepModels({
  sensing,
  setSensing,
  tutors,
  setTutors,
  defaultTutorId,
  setDefaultTutorId,
  error,
  testStatuses,
  onTest,
}: {
  sensing: ModelDraft;
  setSensing: (next: ModelDraft) => void;
  tutors: ModelDraft[];
  setTutors: (next: ModelDraft[]) => void;
  defaultTutorId: string;
  setDefaultTutorId: (id: string) => void;
  error: string;
  testStatuses: Record<string, ConnectionTestStatus>;
  onTest: (role: 'sensing' | 'tutor', model: ModelDraft) => void;
}) {
  const updateTutor = (index: number, next: ModelDraft) =>
    setTutors(tutors.map((item, i) => (i === index ? next : item)));
  const addTutor = () => {
    const id = `tutor-${Date.now()}`;
    setTutors([
      ...tutors,
      { id, label: '', provider: 'anthropic', model: '', apiKey: '', baseUrl: '' },
    ]);
  };
  return (
    <>
      <div className="ob-title">Connect Coco to your models</div>
      <div className="ob-sub">
        The sensing model reads your screen to detect when help may be useful
        and curate context. Tutor models generate proactive suggestions and
        chat responses only when needed.
      </div>
      <ModelFields
        value={sensing}
        onChange={setSensing}
        sensing
        onTest={() => onTest('sensing', sensing)}
        testStatus={testStatuses.sensing}
      />
      <div className="ob-model-section-title">Tutor models</div>
      {tutors.map((tutor, index) => (
        <div key={tutor.id} className="ob-model-wrap">
          <ModelFields
            value={tutor}
            onChange={(next) => updateTutor(index, next)}
            onTest={() => onTest('tutor', tutor)}
            testStatus={testStatuses[tutor.id]}
          />
          <div className="ob-model-actions">
            <label>
              <input
                type="radio"
                name="default-tutor"
                checked={defaultTutorId === tutor.id}
                onChange={() => setDefaultTutorId(tutor.id)}
              />{' '}Default for new chats
            </label>
            {tutors.length > 1 && (
              <button
                type="button"
                className="ob-model-remove"
                onClick={() => {
                  const next = tutors.filter((item) => item.id !== tutor.id);
                  setTutors(next);
                  if (defaultTutorId === tutor.id) setDefaultTutorId(next[0].id);
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      <button type="button" className="ob-model-add" onClick={addTutor}>
        + Add another tutor model
      </button>
      {error && <div className="ob-model-error">{error}</div>}
    </>
  );
}

const MODES = [
  {
    id: 'student_learning',
    name: 'Student Learning',
    desc: 'Coco acts as an AI Tutor — guiding you to learn and solve problems yourself with hints, not answers.',
    img: studentLearningIcon,
  },
  {
    id: 'everyday_support',
    name: 'Everyday Support',
    desc: 'Coco acts as an AI Assistant — spotting tasks worth delegating and suggesting the right AI tool to do them.',
    img: everydaySupportIcon,
  },
];

const AI_CHATBOTS = [
  { id: 'chatgpt', label: 'ChatGPT' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'grok', label: 'Grok' },
  { id: 'qwen', label: 'Qwen' },
];

const AI_AGENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'claude-cowork', label: 'Claude Cowork' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini-cli', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
];

// Prompt for the "Custom" mode. This is Coco's SENSING (observer) prompt —
// what it watches for and when it decides to step in. Only the role/intro is
// user-editable; the input contract and JSON output schema below ("You will
// receive the following input blocks:" onward) are fixed because the sensing
// pipeline parses them. The editable part is seeded with the Everyday Support
// observer intro so users have a working starting point.
const CUSTOM_PROMPT_EDITABLE_DEFAULT = `You are an OBSERVER in an everyday AI-support system. Your role is to analyze the user's screen activity and input to understand what they are doing, and to spot moments where a capable AI tool or agent could take a task off their hands. You must focus solely on understanding, describing, and inferring — never suggest solutions.

The user is going about ordinary computer work — searching for information, writing emails and messages, building documents or slides, organizing files, filling forms, planning, shopping, booking, and so on. Your job is to notice when something they are doing slowly, manually, or with visible friction is exactly the kind of task that could be delegated to an AI assistant (a chatbot for research/drafting, or an execution agent for producing real artifacts).`;

const CUSTOM_PROMPT_FIXED = `You will receive the following input blocks:

<memory>
Long-term personalized context about this user — preferences, the AI tools they have, approaches or guidance that worked for them before, and recurring tasks — accumulated across sessions. Often "(no memory yet)" when nothing has been learned. When present, use it to tailor your analysis to this specific user; it is NOT a description of the current screen.
</memory>

<screenshots>
Periodically captured images of the user's screen. Each image corresponds to a timestamp listed in the text. Images are provided in chronological order after the text; the last image reflects the most recent screen state.
</screenshots>

<conversation_history>
The prior conversation between the user and the AI assistant.
The history may be empty if this is the start of the session.
</conversation_history>

<user_input timestamp="YYYY-MM-DD HH:MM:SS">
The most recent message typed by the user, if any.
</user_input>

<recent_observations>
Your last few observations and how the user reacted to each bubble (ACCEPTED / DISMISSED / NEGATIVE rating / ignored). Use it to avoid nagging: if the user just DISMISSED a suggestion for the activity they are still doing, do NOT re-raise the same kind of suggestion. If the user rated the resulting help as NEGATIVE, classify similar observations as "progress" unless the situation has materially changed.
</recent_observations>

Your responsibilities: understand the timeline of activity, describe the current screen state, infer the user's intention, detect delegation opportunities, identify mistakes made by the human, assess task completion, and detect AI output application.

Assign a single status label that best captures the user's current situation:
- "progress": user is making smooth forward movement with no clear opportunity to delegate
- "inefficient": clear delegation opportunity detected — a task an AI tool/agent could take over
- "mistake": a concrete human-authored mistake is visible
- "stuck": user appears stalled — no visible progress, repeated actions, or prolonged inactivity
- "observing": cannot determine a meaningful status from the available information

Output in JSON format:
{
  "observation": "description of screen activity and how it evolved over time",
  "user_intent": "what the user appears to be trying to accomplish, in under 15 words",
  "inefficiency_patterns": "a task the user is doing manually that an AI tool/agent could take over, or 'no delegation opportunity'",
  "mistake_made_by_human": "a concrete typo, error, or other human-authored mistake visible on screen, or 'no human mistake detected'",
  "task_complete": "yes or no",
  "applying_ai_output": "yes or no",
  "status": "progress | mistake | inefficient | stuck | observing"
}`;

// ── Step components ───────────────────────────────────────────────────────────

function Step0() {
  return (
    <>
      <div className="ob-title">Meet Coco, your proactive co-assistant</div>
      <p className="ob-stat-copy">
        Coco works alongside you — it understands your{' '}
        <strong>full working context</strong> and steps in with the right help,
        right when you need it.
      </p>
      <div className="ob-info-rows">
        <div className="ob-info-row">
          <img
            src={foxWorking}
            alt=""
            className="ob-info-icon"
            style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }}
          />
          <div className="ob-info-text">
            <strong>A co-assistant, not a replacement.</strong> Coco supports
            your work and helps you get better at using AI — you stay in the
            driver&apos;s seat.
          </div>
        </div>
        <div className="ob-info-row">
          <img
            src={foxWaiting}
            alt=""
            className="ob-info-icon"
            style={{ width: 40, height: 40, objectFit: 'contain', flexShrink: 0 }}
          />
          <div className="ob-info-text">
            <strong>Mostly stays out of your way.</strong> If things are going
            smoothly it stays silent; when you need help it steps in with a
            nudge — fully customizable in Settings.
          </div>
        </div>
      </div>
    </>
  );
}

function Step3() {
  const [activeMethod, setActiveMethod] = useState<'direct' | 'invite'>(
    'invite',
  );

  return (
    <>
      <div className="ob-title">Two ways Coco can support</div>
      <div className="ob-sub">
        Coco can reach out proactively when it spots a good moment, or you can
        ask it directly whenever you like.
      </div>

      <div className="ob-tabs">
        <button
          type="button"
          className={`ob-tab ${activeMethod === 'invite' ? 'active' : 'inactive'}`}
          onClick={() => setActiveMethod('invite')}
        >
          ① Provide proactive support
        </button>
        <button
          type="button"
          className={`ob-tab ${activeMethod === 'direct' ? 'active' : 'inactive'}`}
          onClick={() => setActiveMethod('direct')}
        >
          ② Ask Coco directly
        </button>
      </div>

      {activeMethod === 'direct' && (
        <div className="ob-direct-flow">

          {/* Click the Coco avatar on the desktop */}
          <div className="ob-direct-step-label">Click the Coco avatar on your desktop</div>
          <div className="ob-direct-panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#f3f4f6' }}>
              <img src={foxWorking} alt="Coco avatar" style={{ width: 44, height: 44, objectFit: 'contain' }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1f2937' }}>Coco</div>
                <div style={{ fontSize: 9.5, color: '#9ca3af' }}>Click the avatar to open the chat</div>
              </div>
            </div>
          </div>

          <div className="ob-direct-arrow">or</div>

          {/* Grab a screenshot with the global hot key */}
          <div className="ob-direct-step-label">Press a hot key to capture your screen</div>
          <div className="ob-direct-panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#f3f4f6' }}>
              <kbd className="ob-kbd">{HOTKEY_LABEL}</kbd>
              <div style={{ fontSize: 10.5, color: '#6b7280' }}>
                Works anywhere — grabs a screenshot and opens the chat with it attached.
              </div>
            </div>
          </div>

          <div className="ob-method-note" style={{ marginTop: 8 }}>
            Either way the chat opens right away — just describe what you&apos;re
            working on to start a session.
          </div>

        </div>
      )}

      {activeMethod === 'invite' && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              gap: 8,
              marginBottom: 8,
            }}
          >
            {/* Coco avatar — the bubble pops up right next to it */}
            <img
              src={foxWorking}
              alt="Coco avatar"
              style={{ width: 56, height: 56, objectFit: 'contain', flexShrink: 0 }}
            />
            {/* Mini pop-up bubble — how proactive support is delivered */}
            <div className="ob-mini-notif" style={{ flex: 1 }}>
              <div className="ob-mini-notif-hdr">
                <div className="ob-mini-notif-brand">
                  <div className="ob-mini-notif-dot" />
                  AI TUTOR
                </div>
                <div className="ob-mini-notif-x">×</div>
              </div>
              <div className="ob-mini-notif-msg">
                You&apos;ve been editing this prompt by hand for a while — want me
                to show you how to have Claude iterate on it for you?
              </div>
              <div className="ob-mini-notif-btns">
                <button type="button" className="ob-mini-btn-cancel">
                  Dismiss
                </button>
                <button type="button" className="ob-mini-btn-action">
                  Show me →
                </button>
              </div>
            </div>
          </div>
          <div className="ob-method-note">
            Work as usual — Coco watches your context in the background. When it
            spots a moment worth mentioning, a <strong>pop-up bubble</strong>{' '}
            appears with its suggestion. Tap it to see more, or dismiss it and
            keep going.
          </div>
        </>
      )}
    </>
  );
}

function Step4() {
  return (
    <>
      <div className="ob-title">Ask anything, any time</div>
      <div className="ob-sub">
        Use the chat box during a session to ask Coco about your task, AI tools,
        or anything else. Type and press Enter to send.
      </div>
      <div className="ob-chat">
        <div className="ob-chat-header">
          <div className="ob-chat-status" />
          Coco · Session active
        </div>
        <div className="ob-chat-msgs">
          <div className="ob-msg ai">
            <div className="ob-msg-who">Coco</div>
            <div className="ob-msg-bubble">
              Noticed you&apos;ve been on this section a while — want a hint?
            </div>
          </div>
          <div className="ob-msg usr">
            <div className="ob-msg-who">You</div>
            <div className="ob-msg-bubble">help me with this paragraph</div>
          </div>
          <div className="ob-msg ai">
            <div className="ob-msg-who">Coco</div>
            <div className="ob-msg-bubble">
              Try asking Claude to rewrite it with a stronger opening sentence…
            </div>
          </div>
        </div>
        <div className="ob-chat-input-row">
          <input
            className="ob-chat-input"
            placeholder="Type a message…"
            readOnly
          />
          <div className="ob-chat-send">↑</div>
        </div>
      </div>
    </>
  );
}

function StepMode({
  selectedMode,
  setSelectedMode,
  customSystemPrompt,
  setCustomSystemPrompt,
}: {
  selectedMode: string;
  setSelectedMode: (id: string) => void;
  customSystemPrompt: string;
  setCustomSystemPrompt: (v: string) => void;
}) {
  return (
    <>
      <div className="ob-title">How should Coco support you?</div>
      <div className="ob-sub">
        Pick the mode Coco starts in. You can switch anytime from the chat box.
      </div>
      {MODES.map((m) => (
        <div
          key={m.id}
          className={`ob-path-card ${selectedMode === m.id ? 'on' : ''}`}
          onClick={() => setSelectedMode(m.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && setSelectedMode(m.id)}
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <img
            src={m.img}
            alt=""
            style={{ width: 46, height: 46, objectFit: 'contain', flexShrink: 0 }}
          />
          <div>
            <div className="ob-path-title">{m.name}</div>
            <div className="ob-path-desc" style={{ marginBottom: 0 }}>
              {m.desc}
            </div>
          </div>
        </div>
      ))}

      {/* Custom mode — edit the system prompt directly */}
      <div
        className={`ob-path-card ${selectedMode === 'custom' ? 'on' : ''}`}
        onClick={() => setSelectedMode('custom')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setSelectedMode('custom')}
        style={{ display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <img
          src={customModeIcon}
          alt=""
          style={{ width: 46, height: 46, objectFit: 'contain', flexShrink: 0 }}
        />
        <div>
          <div className="ob-path-title">Custom</div>
          <div className="ob-path-desc" style={{ marginBottom: 0 }}>
            Write your own instructions for how Coco should support you.
          </div>
        </div>
      </div>

      {selectedMode === 'custom' && (
        <>
          <div className="ob-sub" style={{ marginTop: 10, marginBottom: 4 }}>
            Describe what Coco should watch for and when it should step in.
            We&apos;ve pre-filled the Everyday Support prompt as a starting
            point — tweak it to fit the moments you want Coco to notice.
          </div>
          <textarea
            className="ob-custom-goal"
            rows={7}
            style={{ fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
          />
          <div
            style={{
              fontSize: 10.5,
              color: '#9ca3af',
              margin: '10px 0 4px',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 700,
            }}
          >
            🔒 Fixed — required by Coco&apos;s sensing pipeline
          </div>
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: 10.5,
              lineHeight: 1.5,
              color: '#6b7280',
              background: '#f3f4f6',
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: '8px 10px',
              maxHeight: 120,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {CUSTOM_PROMPT_FIXED}
          </div>
        </>
      )}
    </>
  );
}

function Step6({
  selectedTools,
  toggleTool,
  showCustom,
  setShowCustom,
  customTool,
  setCustomTool,
  customAgentDesc,
  setCustomAgentDesc,
  showCustomChatbot,
  setShowCustomChatbot,
  customChatbotName,
  setCustomChatbotName,
  customChatbotUrl,
  setCustomChatbotUrl,
  customChatbotDesc,
  setCustomChatbotDesc,
}: {
  selectedTools: string[];
  toggleTool: (id: string) => void;
  showCustom: boolean;
  setShowCustom: (v: boolean) => void;
  customTool: string;
  setCustomTool: (v: string) => void;
  customAgentDesc: string;
  setCustomAgentDesc: (v: string) => void;
  showCustomChatbot: boolean;
  setShowCustomChatbot: (v: boolean) => void;
  customChatbotName: string;
  setCustomChatbotName: (v: string) => void;
  customChatbotUrl: string;
  setCustomChatbotUrl: (v: string) => void;
  customChatbotDesc: string;
  setCustomChatbotDesc: (v: string) => void;
}) {
  return (
    <>
      <div className="ob-title">Your AI toolkit</div>
      <div className="ob-sub">
        Which AI tools do you have access to? Select all that apply — Coco also delegates to them when needed.
      </div>

      <div className="ob-tool-group">
        <div className="ob-tool-group-label">AI Chatbots</div>
        <div className="ob-tool-group-desc">
          You prompt, they respond in <strong>text</strong>. No access to your files or apps — the conversation is their only output.
        </div>
        <div className="ob-chip-grid">
          {AI_CHATBOTS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`ob-chip ${selectedTools.includes(t.id) ? 'on' : ''}`}
              onClick={() => toggleTool(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className={`ob-chip dashed ${showCustomChatbot ? 'on' : ''}`}
            onClick={() => setShowCustomChatbot(!showCustomChatbot)}
          >
            + Custom
          </button>
        </div>
        {showCustomChatbot && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <input
              className="ob-custom-input"
              placeholder="Name — e.g. DeepSeek"
              value={customChatbotName}
              onChange={(e) => setCustomChatbotName(e.target.value)}
            />
            <input
              className="ob-custom-input"
              placeholder="Website URL — e.g. https://chat.deepseek.com/"
              value={customChatbotUrl}
              onChange={(e) => setCustomChatbotUrl(e.target.value)}
            />
            <textarea
              className="ob-custom-input"
              rows={2}
              placeholder="Description — what it's good at, so Coco knows when to suggest it"
              value={customChatbotDesc}
              onChange={(e) => setCustomChatbotDesc(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="ob-tool-group">
        <div className="ob-tool-group-label">AI Agents</div>
        <div className="ob-tool-group-desc">
          <strong>Can use tools</strong> — read/write files, run code, browse the web. They act on your behalf across multi-step tasks.
        </div>
        <div className="ob-chip-grid">
          {AI_AGENTS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`ob-chip ${selectedTools.includes(t.id) ? 'on' : ''}`}
              onClick={() => toggleTool(t.id)}
            >
              {t.label}
            </button>
          ))}
          <button
            type="button"
            className={`ob-chip dashed ${showCustom ? 'on' : ''}`}
            onClick={() => setShowCustom(!showCustom)}
          >
            + Custom
          </button>
        </div>
        {showCustom && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <input
              className="ob-custom-input"
              placeholder="Name — e.g. internal automation tool"
              value={customTool}
              onChange={(e) => setCustomTool(e.target.value)}
            />
            <textarea
              className="ob-custom-input"
              rows={2}
              placeholder="Description — what it does, so Coco knows when to suggest it"
              value={customAgentDesc}
              onChange={(e) => setCustomAgentDesc(e.target.value)}
            />
          </div>
        )}
      </div>
    </>
  );
}

const MEMORY_EXAMPLES = [
  'When I appear to be learning something, suggest useful questions or exercises I can work on.',
  'When I am editing my own work, help me catch errors and typos, and suggest better wording or presentation when appropriate.',
  'If I get stuck using software, give me direct instructions for how to proceed without delegating to another AI chatbot or agent.',
  'When I appear to be working on a long-horizon, multi-step task—such as planning a trip across many tabs—proactively summarize what I have browsed so far in a polished, copy-ready format. No need to delegate this type of assistance to another AI chatbot or agent.',
  'Watch for repetitive manual work, such as reformatting entries one by one, copying the same fields between tools, or repeating similar searches and edits. Proactively offer to automate it by drafting a ready-to-use agent prompt that includes the goal, inputs, exact steps, and desired output format.',
];

function StepMemory({
  userName,
  setUserName,
  memory,
  setMemory,
  error,
}: {
  userName: string;
  setUserName: (value: string) => void;
  memory: string;
  setMemory: (value: string) => void;
  error: string;
}) {
  const addExample = (example: string) => {
    const current = memory.trim();
    if (current.includes(example)) return;
    setMemory(current ? `${current}\n\n${example}` : example);
  };

  return (
    <>
      <div className="ob-title">Give Coco a head start</div>
      <div className="ob-sub">
        Tell Coco what to call you, then optionally share context to remember
        across sessions.
      </div>

      <label className="ob-memory-name-label" htmlFor="ob-user-name">
        Your name or preferred nickname
      </label>
      <input
        id="ob-user-name"
        className="ob-memory-name-input"
        value={userName}
        placeholder="e.g. Ada"
        autoComplete="name"
        onChange={(event) => setUserName(event.target.value)}
      />

      <label className="ob-memory-name-label" htmlFor="ob-initial-memory">
        Memory <span>(optional)</span>
      </label>

      <textarea
        id="ob-initial-memory"
        className="ob-memory-input"
        rows={7}
        value={memory}
        placeholder="What should Coco know about you?"
        onChange={(event) => setMemory(event.target.value)}
      />

      <div className="ob-memory-examples-label">
        Example memories — click to add
      </div>
      <div className="ob-memory-examples">
        {MEMORY_EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="ob-memory-example"
            onClick={() => addExample(example)}
          >
            “{example}”
          </button>
        ))}
      </div>

      <div className="ob-memory-note">
        Memory is stored locally and may be included in context sent to your
        configured models. Don’t enter passwords, API keys, or other secrets.
      </div>
      {error && <div className="ob-model-error">{error}</div>}
    </>
  );
}

function Step8({
  selectedTools,
  customTool,
  customChatbotName,
  selectedMode,
  userName,
  memory,
}: {
  selectedTools: string[];
  customTool: string;
  customChatbotName: string;
  selectedMode: string;
  userName: string;
  memory: string;
}) {
  const allTools = [
    ...[...AI_CHATBOTS, ...AI_AGENTS].filter((t) => selectedTools.includes(t.id)).map((t) => t.label),
    ...(customChatbotName.trim() ? [customChatbotName.trim()] : []),
    ...(customTool.trim() ? [customTool.trim()] : []),
  ];
  const modeLabel =
    selectedMode === 'custom'
      ? 'Custom'
      : MODES.find((m) => m.id === selectedMode)?.name ?? '';

  return (
    <>
      <div className="ob-title">You&apos;re all set 🎉</div>
      <div className="ob-sub">Here&apos;s how Coco is set up for you:</div>

      <div className="ob-divider" />

      <div className="ob-summary-section">
        <div className="ob-summary-label">Mode</div>
        <div className="ob-summary-chips">
          {modeLabel ? (
            <span className="ob-summary-chip">{modeLabel}</span>
          ) : (
            <span className="ob-summary-chip empty">None selected</span>
          )}
        </div>
      </div>

      <div className="ob-summary-section">
        <div className="ob-summary-label">AI Tools</div>
        <div className="ob-summary-chips">
          {allTools.length > 0 ? (
            allTools.map((t) => (
              <span key={t} className="ob-summary-chip">
                {t}
              </span>
            ))
          ) : (
            <span className="ob-summary-chip empty">None selected</span>
          )}
        </div>
      </div>

      <div className="ob-summary-section">
        <div className="ob-summary-label">Name</div>
        <div className="ob-summary-chips">
          <span className="ob-summary-chip">{userName.trim()}</span>
        </div>
      </div>

      <div className="ob-summary-section">
        <div className="ob-summary-label">Memory</div>
        <div className="ob-summary-chips">
          <span className={`ob-summary-chip ${memory.trim() ? '' : 'empty'}`}>
            {memory.trim() ? 'Added' : 'Not provided'}
          </span>
        </div>
      </div>

      <div className="ob-divider" />

      <p className="ob-summary-note">
        Coco will coach you in context, when it spots a moment worth mentioning.
        You can update these settings anytime from the app menu.
      </p>
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OnboardingView() {
  const modelsOnly = new URLSearchParams(window.location.search).get('modelsOnly') === '1';
  const [step, setStep] = useState(0);
  const [showProceedModal, setShowProceedModal] = useState(false);
  const [modelError, setModelError] = useState('');
  const [savingModels, setSavingModels] = useState(false);
  const [sensingModel, setSensingModel] = useState<ModelDraft>({
    id: 'sensing', label: 'Sensing', provider: 'gemini', model: '', apiKey: '', baseUrl: '',
  });
  const [tutorModels, setTutorModels] = useState<ModelDraft[]>([
    { id: 'tutor-1', label: 'Primary tutor', provider: 'anthropic', model: '', apiKey: '', baseUrl: '' },
  ]);
  const [defaultTutorId, setDefaultTutorId] = useState('tutor-1');
  const [connectionTests, setConnectionTests] = useState<
    Record<string, ConnectionTestStatus>
  >({});
  const [initialMemory, setInitialMemory] = useState('');
  const [userName, setUserName] = useState('');
  const [savingMemory, setSavingMemory] = useState(false);
  const [memoryError, setMemoryError] = useState('');

  const testModelConnection = async (
    role: 'sensing' | 'tutor',
    model: ModelDraft,
  ) => {
    const key = role === 'sensing' ? 'sensing' : model.id;
    if (!model.model.trim()) {
      setConnectionTests((current) => ({
        ...current,
        [key]: { state: 'error', message: 'Enter a model ID first.' },
      }));
      return;
    }
    setConnectionTests((current) => ({
      ...current,
      [key]: { state: 'testing', message: '' },
    }));
    const result = await window.electron?.ipcRenderer.invoke(
      'test-model-connection',
      {
        role,
        connection: {
          id: model.id,
          label: model.label || (role === 'sensing' ? 'Sensing' : 'Tutor'),
          provider: model.provider,
          model: model.model,
          baseUrl: model.baseUrl,
        },
        apiKey: model.apiKey,
      },
    );
    const response = result as {
      success?: boolean;
      message?: string;
      error?: string;
    } | undefined;
    setConnectionTests((current) => ({
      ...current,
      [key]: response?.success
        ? { state: 'success', message: response.message || 'Connected.' }
        : { state: 'error', message: response?.error || 'Connection failed.' },
    }));
  };

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-model-configuration')
      .then((config: any) => {
        if (!config?.sensing || !Array.isArray(config.tutors)) return;
        setSensingModel({
          ...config.sensing,
          model: String(config.sensing.model).replace(/^(?:hosted_vllm|tinker)\//, ''),
          apiKey: '',
          baseUrl: config.sensing.baseUrl ?? '',
        });
        setTutorModels(
          config.tutors.map((item: any) => ({
            ...item,
            model: String(item.model).replace(/^(?:hosted_vllm|tinker)\//, ''),
            apiKey: '',
            baseUrl: item.baseUrl ?? '',
          })),
        );
        setDefaultTutorId(config.defaultTutorId);
      })
      .catch(() => {});

    window.electron?.ipcRenderer
      .invoke('get-memory')
      .then((result: any) => setInitialMemory(String(result?.memory ?? '')))
      .catch(() => {});

    window.electron?.ipcRenderer
      .invoke('get-profile')
      .then((profile: any) => setUserName(String(profile?.userName ?? '')))
      .catch(() => {});
  }, []);

  // Step 6 – Mode
  const [selectedMode, setSelectedMode] = useState('everyday_support');
  // Custom mode – only the role/behavior intro is editable; seeded with the
  // Everyday Support intro. The fixed contract is appended on save.
  const [customSystemPrompt, setCustomSystemPrompt] = useState(CUSTOM_PROMPT_EDITABLE_DEFAULT);

  // AI toolkit
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  // Custom agent: name + description (agents open a terminal/app, no URL).
  const [customTool, setCustomTool] = useState('');
  const [customAgentDesc, setCustomAgentDesc] = useState('');
  const [showCustomTool, setShowCustomTool] = useState(false);
  // Custom chatbot: name + website URL (so it can be opened) + description.
  const [showCustomChatbot, setShowCustomChatbot] = useState(false);
  const [customChatbotName, setCustomChatbotName] = useState('');
  const [customChatbotUrl, setCustomChatbotUrl] = useState('');
  const [customChatbotDesc, setCustomChatbotDesc] = useState('');
  const toggleTool = (id: string) =>
    setSelectedTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );

  const stepKeys = modelsOnly
    ? ['models']
    : [
        'models',
        'intro0',
        'howto',
        'ask',
        'mode',
        'toolkit',
        'memory',
        'summary',
      ];
  const totalSteps = stepKeys.length;
  const currentKey = stepKeys[Math.min(step, totalSteps - 1)];

  const handleNext = async () => {
    if (currentKey === 'models') {
      if (!sensingModel.model.trim()) {
        setModelError('Enter a vision-capable sensing model.');
        return;
      }
      if (tutorModels.some((item) => !item.label.trim() || !item.model.trim())) {
        setModelError('Give every tutor model a name and model ID.');
        return;
      }
      setSavingModels(true);
      setModelError('');
      const credentials: Record<string, string> = {};
      if (sensingModel.apiKey.trim()) {
        credentials[`sensing:${sensingModel.provider}`] = sensingModel.apiKey;
      }
      tutorModels.forEach((item) => {
        if (item.apiKey.trim()) credentials[`tutor:${item.provider}`] = item.apiKey;
      });
      const result = await window.electron?.ipcRenderer.invoke(
        'save-model-configuration',
        {
          sensing: {
            id: 'sensing',
            label: 'Sensing',
            provider: sensingModel.provider,
            model: sensingModel.model,
            baseUrl: sensingModel.baseUrl,
          },
          tutors: tutorModels.map(({ apiKey, baseUrl, ...item }) => ({
            ...item,
            baseUrl,
          })),
          defaultTutorId,
          credentials,
        },
      );
      setSavingModels(false);
      if (!(result as { success?: boolean })?.success) {
        setModelError(
          (result as { error?: string })?.error || 'Could not save model configuration.',
        );
        return;
      }
      if (modelsOnly) {
        window.electron?.ipcRenderer.sendMessage('model-configuration-complete');
        window.close();
        return;
      }
    }
    if (currentKey === 'toolkit') {
      const hasChatbot = AI_CHATBOTS.some((t) => selectedTools.includes(t.id));
      const hasAgent = AI_AGENTS.some((t) => selectedTools.includes(t.id));
      if (!hasChatbot || !hasAgent) {
        setShowProceedModal(true);
        return;
      }
    }
    if (currentKey === 'memory') {
      if (!userName.trim()) {
        setMemoryError('Enter the name you want Coco to use.');
        return;
      }
      setSavingMemory(true);
      setMemoryError('');
      const result = await window.electron?.ipcRenderer.invoke('save-memory', {
        memory: initialMemory.trim(),
      });
      setSavingMemory(false);
      if (!(result as { success?: boolean })?.success) {
        setMemoryError(
          (result as { error?: string })?.error || 'Could not save memory.',
        );
        return;
      }
    }
    setStep((s) => s + 1);
  };

  const sendProfile = (skipped: boolean) => {
    const profile = {
      onboardingComplete: true,
      userName: skipped ? '' : userName.trim(),
      tutorScenario: skipped ? 'everyday_support' : selectedMode,
      aiTools: skipped
        ? []
        : [
            ...selectedTools,
            ...(customTool.trim()
              ? [encodeCustomAgent(customTool, customAgentDesc)]
              : []),
            ...(customChatbotName.trim() && customChatbotUrl.trim()
              ? [encodeCustomChatbot(customChatbotName, customChatbotUrl, customChatbotDesc)]
              : []),
          ],
      // Custom system prompt only applies to the "custom" mode. Only the intro
      // is user-edited; the fixed input/output contract is always appended.
      customSystemPrompt:
        skipped || selectedMode !== 'custom'
          ? ''
          : `${customSystemPrompt.trim()}\n\n${CUSTOM_PROMPT_FIXED}`,
      completedAt: new Date().toISOString(),
    };
    window.electron?.ipcRenderer.sendMessage('onboarding-complete', profile);
    window.close();
  };

  const isLast = step === totalSteps - 1;

  return (
    <div className="ob-root">
      <div className="ob-card">
        {/* Header */}
        <div className="ob-header">
          <div className="ob-brand">
            <span className="ob-brand-dot" />
            <span className="ob-brand-name">
              {modelsOnly ? 'Model setup' : 'Getting started'}
            </span>
          </div>
          <button
            type="button"
            className="ob-close-btn"
            aria-label="Close setup for now"
            title="Close for now"
            onClick={() => window.electron?.ipcRenderer.sendMessage('hide-onboarding')}
          >
            ×
          </button>
        </div>

        {/* Progress */}
        <div className="ob-progress">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={i}
              className={`ob-pbar ${i < step ? 'done' : i === step ? 'active' : 'future'}`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="ob-body">
          {currentKey === 'models' && (
            <StepModels
              sensing={sensingModel}
              setSensing={setSensingModel}
              tutors={tutorModels}
              setTutors={setTutorModels}
              defaultTutorId={defaultTutorId}
              setDefaultTutorId={setDefaultTutorId}
              error={modelError}
              testStatuses={connectionTests}
              onTest={testModelConnection}
            />
          )}
          {currentKey === 'intro0' && <Step0 />}
          {currentKey === 'howto' && <Step3 />}
          {currentKey === 'ask' && <Step4 />}
          {currentKey === 'mode' && (
            <StepMode
              selectedMode={selectedMode}
              setSelectedMode={setSelectedMode}
              customSystemPrompt={customSystemPrompt}
              setCustomSystemPrompt={setCustomSystemPrompt}
            />
          )}
          {currentKey === 'toolkit' && (
            <Step6
              selectedTools={selectedTools}
              toggleTool={toggleTool}
              showCustom={showCustomTool}
              setShowCustom={setShowCustomTool}
              customTool={customTool}
              setCustomTool={setCustomTool}
              customAgentDesc={customAgentDesc}
              setCustomAgentDesc={setCustomAgentDesc}
              showCustomChatbot={showCustomChatbot}
              setShowCustomChatbot={setShowCustomChatbot}
              customChatbotName={customChatbotName}
              setCustomChatbotName={setCustomChatbotName}
              customChatbotUrl={customChatbotUrl}
              setCustomChatbotUrl={setCustomChatbotUrl}
              customChatbotDesc={customChatbotDesc}
              setCustomChatbotDesc={setCustomChatbotDesc}
            />
          )}
          {currentKey === 'memory' && (
            <StepMemory
              userName={userName}
              setUserName={setUserName}
              memory={initialMemory}
              setMemory={setInitialMemory}
              error={memoryError}
            />
          )}
          {currentKey === 'summary' && (
            <Step8
              selectedTools={selectedTools}
              customTool={customTool}
              customChatbotName={customChatbotName}
              selectedMode={selectedMode}
              userName={userName}
              memory={initialMemory}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="ob-nav">
          <button
            type="button"
            className="ob-btn ob-btn-ghost"
            onClick={() => setStep((s) => s - 1)}
            style={{ visibility: step === 0 ? 'hidden' : 'visible' }}
          >
            ← Back
          </button>
          <span className="ob-counter">
            {step + 1} / {totalSteps}
          </span>
          {isLast ? (
            <button
              type="button"
              className="ob-btn ob-btn-green"
              onClick={modelsOnly ? handleNext : () => sendProfile(false)}
              disabled={savingModels}
            >
              {modelsOnly
                ? (savingModels ? 'Saving…' : 'Save & start Coco 🐾')
                : 'Start Coco 🐾'}
            </button>
          ) : (
            <button
              type="button"
              className="ob-btn ob-btn-primary"
              onClick={handleNext}
              disabled={savingModels || savingMemory}
            >
              {savingModels || savingMemory
                ? 'Saving…'
                : currentKey === 'memory'
                  ? initialMemory.trim()
                    ? 'Save & continue →'
                    : 'Continue without memory →'
                  : 'Next →'}
            </button>
          )}
        </div>

        {/* Proceed confirmation modal — scoped inside card */}
        {showProceedModal && (
          <div className="ob-modal-overlay">
            <div className="ob-modal">
              <div className="ob-modal-title">Want to proceed?</div>
              <div className="ob-modal-body">
                We suggest selecting at least one <strong>chatbot</strong> and one <strong>agent</strong> so Coco can coach you on different types of tasks.
              </div>
              <div className="ob-modal-actions">
                <button
                  type="button"
                  className="ob-btn ob-btn-primary"
                  onClick={() => setShowProceedModal(false)}
                >
                  Go back
                </button>
                <button
                  type="button"
                  className="ob-btn ob-btn-ghost"
                  onClick={() => { setShowProceedModal(false); setStep((s) => s + 1); }}
                >
                  Proceed anyway
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
