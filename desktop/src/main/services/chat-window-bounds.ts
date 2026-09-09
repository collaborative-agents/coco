export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Resize a window while keeping its right edge fixed and the result on screen.
 * This makes the panel expand to the left and collapse from the left.
 */
export default function resizeBoundsKeepingRightEdge(
  current: WindowBounds,
  workArea: WindowBounds,
  requestedWidth: number,
  margin = 0,
): WindowBounds {
  const availableWidth = Math.max(1, workArea.width - margin * 2);
  const availableHeight = Math.max(1, workArea.height - margin * 2);
  const width = Math.min(requestedWidth, availableWidth);
  const height = Math.min(current.height, availableHeight);
  const minX = workArea.x + margin;
  const minY = workArea.y + margin;
  const maxX = workArea.x + workArea.width - margin - width;
  const maxY = workArea.y + workArea.height - margin - height;
  const rightAnchoredX = current.x + current.width - width;

  return {
    x: Math.max(minX, Math.min(rightAnchoredX, maxX)),
    y: Math.max(minY, Math.min(current.y, maxY)),
    width,
    height,
  };
}
