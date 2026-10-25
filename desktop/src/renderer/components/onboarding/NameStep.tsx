export default function NameStep({
  value,
  onChange,
  error,
  onNext,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string;
  onNext: () => void;
}) {
  return (
    <div className="coco-setup-panel coco-setup-panel-padded ob-name">
      <label htmlFor="ob-user-name">
        Your name or preferred nickname
        <input
          id="ob-user-name"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onNext();
          }}
          placeholder="e.g. Ada"
          autoComplete="name"
          maxLength={100}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'ob-name-error' : 'ob-name-hint'}
        />
      </label>
      <p id="ob-name-hint">
        This is how Coco will address you. You can change it later in Settings.
      </p>
      {error && (
        <div id="ob-name-error" className="coco-setup-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
