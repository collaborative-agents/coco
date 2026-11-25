import fs from 'fs';
import path from 'path';

export default class ScreenHistorySettings {
  private pending = Promise.resolve();
  constructor(
    private readonly settingsPath: () => string,
    private readonly environment: () => string | undefined = () =>
      process.env.COCO_SCREEN_HISTORY_ENABLED,
  ) {}

  read(): boolean {
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8'));
      if (typeof saved.enabled !== 'boolean')
        throw new Error('Invalid screenshot history setting.');
      return saved.enabled;
    } catch (error) {
      // An unreadable saved choice must not silently re-enable collection.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      return ['1', 'true', 'yes', 'on'].includes(
        (this.environment() ?? '1').trim().toLowerCase(),
      );
    }
  }

  set(
    enabled: boolean,
    apply: (value: boolean) => Promise<void>,
  ): Promise<void> {
    const update = this.pending.then(async () => {
      if (typeof enabled !== 'boolean')
        throw new Error('Choose whether screenshot history is enabled.');
      await apply(enabled);
      const file = this.settingsPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ enabled })}\n`, {
        mode: 0o600,
      });
      fs.renameSync(`${file}.tmp`, file);
    });
    this.pending = update.catch(() => {});
    return update;
  }
}
