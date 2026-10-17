import { AGENT_MODES } from '../../../shared/agent-modes';
import { AI_TOOLS } from '../observation-types';

interface Props {
  scenario: string;
  setScenario: (value: string) => void;
  aiTools: string[];
  setAiTools: (value: string[]) => void;
  customSystemPrompt: string;
  setCustomSystemPrompt: (value: string) => void;
}

export default function WorkflowStep({
  scenario,
  setScenario,
  aiTools,
  setAiTools,
  customSystemPrompt,
  setCustomSystemPrompt,
}: Props) {
  return (
    <div className="coco-setup-panel coco-setup-panel-padded">
      <label className="ob-workflow-field">
        Agent mode
        <select
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
        >
          {AGENT_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      {scenario === 'custom' && (
        <label className="ob-workflow-field">
          Custom instructions
          <textarea
            rows={5}
            value={customSystemPrompt}
            onChange={(event) => setCustomSystemPrompt(event.target.value)}
            placeholder="Describe when and how Coco should help you."
          />
        </label>
      )}
      <fieldset className="ob-workflow-tools">
        <legend>Your AI tools</legend>
        {Object.values(AI_TOOLS).map((tool) => (
          <label key={tool.id}>
            <input
              type="checkbox"
              checked={aiTools.includes(tool.id)}
              onChange={(event) =>
                setAiTools(
                  event.target.checked
                    ? [...aiTools, tool.id]
                    : aiTools.filter((id) => id !== tool.id),
                )
              }
            />
            {tool.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
