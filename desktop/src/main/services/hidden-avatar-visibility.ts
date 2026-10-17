export type HiddenAvatarSurface = 'history' | 'daily-memory-review';

/** Tracks the exceptional surfaces allowed to reveal a hidden avatar window. */
export class HiddenAvatarVisibility {
  private readonly visibleSurfaces = new Set<HiddenAvatarSurface>();

  setVisible(surface: HiddenAvatarSurface, visible: boolean): void {
    if (visible) this.visibleSurfaces.add(surface);
    else this.visibleSurfaces.delete(surface);
  }

  shouldShowWindow(): boolean {
    return this.visibleSurfaces.size > 0;
  }

  clear(): void {
    this.visibleSurfaces.clear();
  }
}
