import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Ordered atomic writes keep settings and history readable after an interrupted write. */
export class JsonFile<T> {
  private writing: Promise<void> = Promise.resolve();
  constructor(private path: string) {}

  async read(fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw error;
    }
  }

  write(value: T) {
    const content = JSON.stringify(value, null, 2);
    const task = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writing = task.catch(() => {});
    return task;
  }
}
