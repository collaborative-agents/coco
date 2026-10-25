import type { ReactNode } from 'react';

interface Props {
  id: string;
  title: string;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

export default function SettingsToggle({
  id,
  title,
  description,
  checked,
  disabled,
  onChange,
}: Props) {
  return (
    <label className="settings-toggle-row" htmlFor={id}>
      <span className="settings-toggle-copy">
        <strong id={`${id}-label`}>{title}</strong>
        <span id={`${id}-help`}>{description}</span>
      </span>
      <span className="settings-toggle-control">
        <span aria-hidden="true">{checked ? 'On' : 'Off'}</span>
        <input
          id={id}
          className="settings-switch"
          type="checkbox"
          role="switch"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
  );
}
