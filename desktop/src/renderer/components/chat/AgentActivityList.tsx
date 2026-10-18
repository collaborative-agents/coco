import type { AgentActivity } from '../../../shared/agent-execution';
import type { TutorToolCall } from '../observation-types';
import { ToolCallCard } from './ToolCallCard';
import { TutorMessage } from './MessageContent';
import toolSummary from './tool-summary';
import { S } from './styles';

export function groupActivity(activity: AgentActivity[]) {
  const groups: (
    | { kind: 'tools'; calls: TutorToolCall[]; key: string }
    | { kind: 'message'; text: string; key: string }
    | { kind: 'question'; call: TutorToolCall; key: string }
  )[] = [];
  activity.forEach((item, index) => {
    if (item.kind === 'message') {
      groups.push({ ...item, key: `message-${index}` });
    } else if (item.call.name === 'ask_user_question') {
      groups.push({ kind: 'question', call: item.call, key: item.call.id });
    } else {
      const last = groups[groups.length - 1];
      if (last?.kind === 'tools') last.calls.push(item.call);
      else
        groups.push({ kind: 'tools', calls: [item.call], key: item.call.id });
    }
  });
  return groups;
}

function ToolGroup({ calls }: { calls: TutorToolCall[] }) {
  if (calls.length === 1) return <ToolCallCard call={calls[0]} />;
  const running = calls.find((call) => call.status === 'running');
  const failed = calls.filter((call) => call.status === 'error').length;
  const summaries = [...new Set(calls.map(toolSummary))];
  const summary = running
    ? toolSummary(running)
    : summaries.slice(0, 2).join(' · ');
  let status = `${calls.length} steps`;
  if (running) status += ' · Working…';
  else if (!failed) status += ' · Done';
  if (failed) status += ` · ${failed} failed`;
  return (
    <details className="tool-activity-group">
      <summary>
        <span className="tool-activity-description">
          {summary}
          {!running && summaries.length > 2 ? ' · More actions' : ''}
        </span>
        <span className={`tool-activity-status ${failed ? 'error' : ''}`}>
          {status}
        </span>
        <span className="tool-activity-detail-label">Details</span>
      </summary>
      <div className="tool-activity-steps">
        {calls.map((call) => (
          <ToolCallCard key={call.id} call={call} grouped />
        ))}
      </div>
    </details>
  );
}

export default function AgentActivityList({
  activity,
  interactive,
}: {
  activity: AgentActivity[];
  interactive: boolean;
}) {
  return (
    <div style={S.toolStack}>
      {groupActivity(activity).map((item) => {
        if (item.kind === 'tools')
          return <ToolGroup key={item.key} calls={item.calls} />;
        if (item.kind === 'question')
          return (
            <ToolCallCard
              key={item.key}
              call={item.call}
              interactive={interactive}
            />
          );
        return (
          <div key={item.key} style={S.tutorBubble}>
            <TutorMessage text={item.text} />
          </div>
        );
      })}
    </div>
  );
}
