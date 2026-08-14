import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export class RemoteTransportWorkerLock {
  private handle?: FileHandle;

  constructor(private readonly filePath = path.resolve(process.env.NEXUS_REMOTE_GITHUB_LOCK_FILE ?? 'data/remote-github-worker.lock')) {}

  async acquire(now = new Date()): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      this.handle = await open(this.filePath, 'wx', 0o600);
      await this.handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`, 'utf8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const stale = await this.isStale();
    if (!stale) throw new Error('Another NEXUS remote GitHub worker is already active.');
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    this.handle = await open(this.filePath, 'wx', 0o600);
    await this.handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now.toISOString(), reclaimed: true })}\n`, 'utf8');
  }

  async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    await unlink(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private async isStale(): Promise<boolean> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as { pid?: unknown };
      if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0) return false;
      try {
        process.kill(Number(parsed.pid), 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') return true;
        if (code === 'EPERM') return false;
        return false;
      }
    } catch {
      return false;
    }
  }
}
