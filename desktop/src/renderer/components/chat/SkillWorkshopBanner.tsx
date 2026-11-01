import { useEffect, useRef, useState } from 'react';
import type { SkillWorkshopSession } from '../../../shared/skill-workshop';
import './SkillWorkshopBanner.css';

export default function SkillWorkshopBanner({
  sessionId,
  busy,
}: {
  sessionId: string | null;
  busy: boolean;
}) {
  const [session, setSession] = useState<SkillWorkshopSession | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    let revision = 0;
    setSession(null);
    setError('');
    const refresh = async () => {
      const request = ++revision;
      try {
        const value = sessionId
          ? await window.electron.ipcRenderer.invoke(
              'skill-workshop-session',
              sessionId,
            )
          : null;
        if (active && request === revision)
          setSession(value?.sessionId === sessionId ? value : null);
      } catch {
        if (active && request === revision)
          setError(
            'Could not load skill progress. Reopen the conversation to retry.',
          );
      }
    };
    void refresh();
    const off = window.electron?.ipcRenderer.on?.(
      'skill-workshop-changed',
      refresh,
    );
    return () => {
      active = false;
      off?.();
    };
  }, [sessionId]);
  const action = async (
    channel: 'skill-workshop-start' | 'skill-workshop-save',
  ) => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const value = await window.electron.ipcRenderer.invoke(
        channel,
        channel === 'skill-workshop-start' ? true : sessionId,
      );
      if (channel === 'skill-workshop-save') setSession(value);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not complete the request. Please retry.',
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  if (!session || session.sessionId !== sessionId) return null;
  const tested = session.trials.some(
    (trial) => trial.draftVersion === session.version,
  );
  const steps = [
    { label: 'Create a skill', complete: Boolean(session.draft) },
    { label: 'Test the latest version', complete: tested },
    { label: 'Save to skills', complete: Boolean(session.savedSkillId) },
  ];
  return (
    <aside
      className="skill-workshop-banner"
      aria-label="Skill creation progress"
    >
      <div className="skill-workshop-heading">
        <strong>Build your own skill</strong>
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => void action('skill-workshop-start')}
        >
          Start a new skill
        </button>
      </div>
      <ol aria-label="Skill creation steps">
        {steps.map((step, index) => (
          <li
            key={step.label}
            aria-current={
              index === steps.findIndex((item) => !item.complete)
                ? 'step'
                : undefined
            }
          >
            <span aria-hidden="true">{step.complete ? '✓' : index + 1}</span>{' '}
            {step.label}
          </li>
        ))}
      </ol>
      <p>
        {session.savedSkillId
          ? 'Your skill is saved. Choose it from Skills in the chat input bar.'
          : tested
            ? 'Tell Coco what to improve, or save the skill when you’re happy with the result.'
            : session.draft
              ? 'Review the draft below, then give Coco a real example to test it.'
              : 'Tell Coco about a task you do repeatedly and how you like to work.'}
      </p>
      {tested && !session.savedSkillId && (
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => void action('skill-workshop-save')}
        >
          {pending ? 'Saving…' : 'Save skill'}
        </button>
      )}
      {session.savedSkillId && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('coco:open-skills'))}
        >
          Browse my skills
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </aside>
  );
}
