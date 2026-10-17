import WorkspaceIcon from './WorkspaceIcon';
import { S } from './styles';

interface Props {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export default function WindowControls({ expanded, onExpandedChange }: Props) {
  return (
    <>
      <button
        type="button"
        style={S.iconBtn}
        title={expanded ? 'Collapse' : 'Expand'}
        aria-label={expanded ? 'Collapse' : 'Expand'}
        onClick={() => onExpandedChange(!expanded)}
      >
        <WorkspaceIcon name={expanded ? 'collapse' : 'expand'} />
      </button>
      <button
        type="button"
        style={S.iconBtn}
        title="Close"
        aria-label="Close"
        onClick={() => window.close()}
      >
        <WorkspaceIcon name="close" />
      </button>
    </>
  );
}
