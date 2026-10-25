import foxWorking from '../../../../assets/pet1.png';

export default function WelcomeStep() {
  return (
    <div className="coco-setup-panel ob-welcome">
      <img src={foxWorking} alt="Coco, your desktop companion" />
      <h2>A little company. A little help.</h2>
      <p>
        Coco notices what you’re working on and offers a suggestion when it can
        help. You choose when to engage.
      </p>
      <div className="ob-welcome-features">
        <div>
          <strong>Help in the moment</strong>
          <span>
            Get a nudge when you’re stuck or discover a useful way to work with
            AI.
          </span>
        </div>
        <div>
          <strong>A conversation away</strong>
          <span>
            Open chat from Coco’s avatar or the menu-bar icon and ask anything.
          </span>
        </div>
      </div>
    </div>
  );
}
