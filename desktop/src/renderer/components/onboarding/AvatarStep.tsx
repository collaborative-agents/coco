import foxWorking from '../../../../assets/pet1.png';

function DesktopPreview({ hidden }: { hidden: boolean }) {
  return (
    <span className="ob-desktop-preview" aria-hidden="true">
      <span className="ob-preview-menubar">
        <span />
        <img src={foxWorking} alt="" />
      </span>
      <span className="ob-preview-window">
        <i />
        <i />
        <i />
      </span>
      {!hidden && <img className="ob-preview-avatar" src={foxWorking} alt="" />}
    </span>
  );
}

export default function AvatarStep({
  hidden,
  onChange,
}: {
  hidden: boolean;
  onChange: (hidden: boolean) => void;
}) {
  return (
    <>
      <div
        className="coco-setup-panel ob-avatar-options"
        role="radiogroup"
        aria-label="Avatar visibility"
      >
        {[false, true].map((hide) => (
          <label
            htmlFor={hide ? 'ob-hide-avatar' : 'ob-reveal-avatar'}
            key={String(hide)}
            className={`ob-avatar-option ${hidden === hide ? 'selected' : ''}`}
          >
            <input
              id={hide ? 'ob-hide-avatar' : 'ob-reveal-avatar'}
              type="radio"
              name="avatar-visibility"
              value={hide ? 'hide' : 'reveal'}
              checked={hidden === hide}
              onChange={() => onChange(hide)}
            />
            <span className="ob-setting-copy">
              <strong>{hide ? 'Menu bar only' : 'Avatar + menu bar'}</strong>
              <span>
                {hide
                  ? 'Keep your desktop clear. Open Coco from the icon in your menu bar.'
                  : 'Keep Coco alongside your work, with a desktop avatar and a menu-bar icon.'}
              </span>
            </span>
            <DesktopPreview hidden={hide} />
          </label>
        ))}
      </div>
      <p className="coco-setup-note">
        The menu-bar icon is always available, even when the avatar is hidden.
        On Windows and Linux, find Coco in the system tray.
      </p>
      <p className="coco-setup-note">
        You can reveal or hide the avatar later in Settings. This does not
        change observation or voice activation.
      </p>
    </>
  );
}
