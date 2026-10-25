import cocoHelping from '../../../../assets/tool1.png';
import cocoReady from '../../../../assets/wait1.png';
import PetMenuIcon from '../PetMenuIcon';
import ObservationBubble from '../ObservationBubble';

export default function WelcomeStep() {
  return (
    <div className="ob-welcome-features">
      <div className="coco-setup-panel coco-setup-panel-padded ob-feature-card">
        <div
          className="ob-feature-scene"
          role="img"
          aria-label="Coco offering a helpful suggestion"
        >
          <img
            className="ob-feature-illustration"
            src={cocoHelping}
            alt=""
            draggable={false}
          />
          <div className="ob-feature-bubble" inert aria-hidden="true">
            <ObservationBubble
              bubble={{
                status: 'support_needed',
                phrase:
                  'Comparing options? I can pull the key differences into a table.',
                fadingOut: false,
                showHelpButton: true,
              }}
            />
          </div>
        </div>
        <div className="ob-feature-copy">
          <strong>Help in the moment</strong>
          <span>
            Get a nudge when you’re stuck or discover a useful way to work with
            AI.
          </span>
        </div>
      </div>
      <div className="coco-setup-panel coco-setup-panel-padded ob-feature-card">
        <div
          className="ob-feature-scene"
          role="img"
          aria-label="Coco’s menu with Chat highlighted"
        >
          <img
            className="ob-feature-illustration"
            src={cocoReady}
            alt=""
            draggable={false}
          />
          <div className="ob-feature-menu" aria-hidden="true">
            <div className="ob-feature-menu-active">
              <PetMenuIcon name="chat" />
              Chat
            </div>
            <div>
              <PetMenuIcon name="settings" />
              Settings
            </div>
            <div>
              <PetMenuIcon name="hide" />
              Hide
            </div>
          </div>
        </div>
        <div className="ob-feature-copy">
          <strong>A conversation away</strong>
          <span>
            Open chat from Coco’s avatar or the menu-bar icon and ask anything.
          </span>
        </div>
      </div>
    </div>
  );
}
