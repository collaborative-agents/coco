import { useState } from 'react';
import { encodeCustomChatbot, encodeCustomAgent } from './observation-types';
import './OnboardingView.css';
import foxWorking from '../../../assets/pet.png';
import foxStudying from '../../../assets/write1.png';
import foxEveryday from '../../../assets/tool1.png';
import foxWaiting from '../../../assets/wait1.png';

const MODES = [
  {
    id: 'student_learning',
    name: 'Student Learning',
    desc: 'Coco acts as an AI Tutor — guiding you to learn and solve problems yourself with hints, not answers.',
    img: foxStudying,
  },
  {
    id: 'everyday_support',
    name: 'Everyday Support',
    desc: 'Coco acts as an AI Assistant — spotting tasks worth delegating and suggesting the right AI tool to do them.',
    img: foxEveryday,
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
Your last few observations and how the user reacted to each bubble (ACCEPTED / DISMISSED / ignored). Use it to avoid nagging: if the user just DISMISSED a suggestion for the activity they are still doing, do NOT re-raise the same kind of suggestion.
</recent_observations>

Your responsibilities: understand the timeline of activity, describe the current screen state, infer the user's intention, detect delegation opportunities, identify AI tool interaction problems, assess task completion, and detect AI output application.

Assign a single status label that best captures the user's current situation:
- "progress": user is making smooth forward movement with no clear opportunity to delegate
- "inefficient": clear delegation opportunity detected — a task an AI tool/agent could take over
- "ai_struggle": user is actively using an AI tool but struggling
- "stuck": user appears stalled — no visible progress, repeated actions, or prolonged inactivity
- "observing": cannot determine a meaningful status from the available information

Output in JSON format:
{
  "observation": "description of screen activity and how it evolved over time",
  "user_intent": "what the user appears to be trying to accomplish, in under 15 words",
  "inefficiency_patterns": "a task the user is doing manually that an AI tool/agent could take over, or 'no delegation opportunity'",
  "ai_interaction_problems": "difficulties the user is having with an AI tool, or 'no AI interaction problem'",
  "task_complete": "yes or no",
  "applying_ai_output": "yes or no",
  "status": "progress | inefficient | ai_struggle | stuck | observing"
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

          <div className="ob-method-note" style={{ marginTop: 8 }}>
            The chat opens right away — just describe what you&apos;re working on
            to start a session.
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
        <span style={{ fontSize: 30, width: 46, textAlign: 'center', flexShrink: 0 }}>✏️</span>
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
        Which AI tools do you have access to? Select all that apply — Coco will coach you on using the best of them.
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

function Step8({
  selectedTools,
  customTool,
  customChatbotName,
  selectedMode,
}: {
  selectedTools: string[];
  customTool: string;
  customChatbotName: string;
  selectedMode: string;
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
  const [step, setStep] = useState(0);
  const [showProceedModal, setShowProceedModal] = useState(false);

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

  const stepKeys = [
    'intro0',
    'howto',
    'ask',
    'mode',
    'toolkit',
    'summary',
  ];
  const totalSteps = stepKeys.length;
  const currentKey = stepKeys[Math.min(step, totalSteps - 1)];

  const handleNext = () => {
    if (currentKey === 'toolkit') {
      const hasChatbot = AI_CHATBOTS.some((t) => selectedTools.includes(t.id));
      const hasAgent = AI_AGENTS.some((t) => selectedTools.includes(t.id));
      if (!hasChatbot || !hasAgent) {
        setShowProceedModal(true);
        return;
      }
    }
    setStep((s) => s + 1);
  };

  const sendProfile = (skipped: boolean) => {
    const profile = {
      onboardingComplete: true,
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
            <span className="ob-brand-name">Getting started</span>
          </div>
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
          {currentKey === 'summary' && (
            <Step8
              selectedTools={selectedTools}
              customTool={customTool}
              customChatbotName={customChatbotName}
              selectedMode={selectedMode}
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
              onClick={() => sendProfile(false)}
            >
              Start Coco 🐾
            </button>
          ) : (
            <button
              type="button"
              className="ob-btn ob-btn-primary"
              onClick={handleNext}
            >
              Next →
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
