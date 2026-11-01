import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import CuratedSkills from './CuratedSkills';
import WorkspaceDialog from './WorkspaceDialog';
import './WorkspaceDialog.css';
import ActionTooltip from './ActionTooltip';
import { S } from './styles';
import SkillIcon from './SkillIcon';
import './SkillPicker.css';

export default function SkillPicker({
  disabled,
  onSelect,
}: {
  disabled: boolean;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('coco:open-skills', show);
    return () => window.removeEventListener('coco:open-skills', show);
  }, []);
  return (
    <>
      <div className="skill-picker-trigger">
        <ActionTooltip label="Skills">
          <button
            type="button"
            style={S.micBtn}
            disabled={disabled}
            aria-label="Skills"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((shown) => !shown)}
          >
            <SkillIcon />
          </button>
        </ActionTooltip>
      </div>
      {open &&
        createPortal(
          <WorkspaceDialog
            open
            title="Your skills"
            className="skill-picker-dialog"
            onClose={() => setOpen(false)}
          >
            <CuratedSkills
              onCreate={() => setOpen(false)}
              onSelect={
                disabled
                  ? undefined
                  : (skill) => {
                      onSelect(skill.name);
                      setOpen(false);
                    }
              }
            />
          </WorkspaceDialog>,
          document.body,
        )}
    </>
  );
}
