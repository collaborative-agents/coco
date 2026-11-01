import { useEffect, useState } from 'react';
import type { CuratedSkill } from '../../../shared/skills';
import { TutorMessage } from './MessageContent';
import './CuratedSkills.css';
import SkillIcon from './SkillIcon';

export default function CuratedSkills({
  onSelect,
  onCreate,
}: {
  onSelect?: (skill: CuratedSkill) => void;
  onCreate?: () => void;
} = {}) {
  const [creating, setCreating] = useState(false);
  const [skills, setSkills] = useState<CuratedSkill[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await window.electron.ipcRenderer.invoke(
          'curated-skills-list',
        );
        if (active) {
          setSkills(Array.isArray(result) ? result : []);
          setError('');
        }
      } catch {
        if (active)
          setError('Could not load your skills. Reopen this page to retry.');
      } finally {
        if (active) setLoading(false);
      }
    };
    refresh();
    const off = window.electron.ipcRenderer.on?.(
      'curated-skills-changed',
      refresh,
    );
    return () => {
      active = false;
      off?.();
    };
  }, []);
  return (
    <section className="curated-skills" aria-label="Curated skills">
      <div
        className="skill-picker-toolbar"
        role="group"
        aria-label="Skill actions"
      >
        <button
          type="button"
          className="skill-picker-create"
          disabled={creating}
          onClick={async () => {
            setCreating(true);
            setError('');
            try {
              await window.electron.ipcRenderer.invoke('skill-workshop-start');
              onCreate?.();
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : 'Could not start skill creation.',
              );
            } finally {
              setCreating(false);
            }
          }}
        >
          {creating ? 'Opening…' : 'Create skill'}
        </button>
        <button
          type="button"
          onClick={() =>
            window.electron.ipcRenderer
              .invoke('curated-skills-import')
              .catch(() =>
                setError(
                  'Could not import this skill. Check that the folder contains a valid SKILL.md.',
                ),
              )
          }
        >
          Import skill
        </button>
      </div>
      {loading && (
        <p role="status" className="skill-picker-status">
          Loading skills…
        </p>
      )}
      {!loading && skills.length === 0 && !error && (
        <p className="skill-picker-empty">No skills yet.</p>
      )}
      {skills.length > 0 && (
        <input
          className="skill-picker-search"
          type="search"
          aria-label="Search skills"
          placeholder="Search your skills…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      {skills.length > 0 &&
        !skills.some((skill) =>
          `${skill.name} ${skill.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ) && <p className="skill-picker-status">No skills match “{query}”.</p>}
      {skills
        .filter((skill) =>
          `${skill.name} ${skill.description}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
        .map((skill) => (
          <div key={skill.id} className="skill-picker-row">
            <button
              type="button"
              className="skill-picker-select"
              disabled={!onSelect}
              onClick={() => onSelect?.(skill)}
            >
              <span className="skill-picker-glyph">
                <SkillIcon />
              </span>
              <span className="skill-picker-copy">
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
              </span>
              <span className="skill-picker-add" aria-hidden="true">
                ↗
              </span>
            </button>
            <details key={skill.id} className="workflow-skill-card">
              <summary>View instructions</summary>
              <TutorMessage text={skill.markdown} />
              {skill.files.map((file) => (
                <details key={file.name}>
                  <summary>{file.name}</summary>
                  <TutorMessage text={file.content} />
                </details>
              ))}
              <div className="workflow-actions">
                <button
                  type="button"
                  onClick={() =>
                    window.electron.ipcRenderer
                      .invoke('curated-skills-reveal', skill.id)
                      .catch(() => setError('Could not open the skill folder.'))
                  }
                >
                  Open skill folder
                </button>
              </div>
            </details>
          </div>
        ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
