import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return readBackupOrFallback(filePath, fallback);
    }

    try {
      const recovered = JSON.parse(await readFile(backupPath(filePath), 'utf8'));
      console.warn(`Recovered ${filePath} from its last valid backup.`);
      return recovered;
    } catch (backupError) {
      if (backupError?.code === 'ENOENT') throw invalidJsonError(filePath, error);
      throw invalidJsonError(filePath, error, backupError);
    }
  }
}

export async function writeJsonFileAtomic(filePath, value, { backup = true } = {}) {
  const contents = JSON.stringify(value, null, 2);

  if (backup) {
    try {
      const previous = await readFile(filePath, 'utf8');
      JSON.parse(previous);
      await replaceFile(backupPath(filePath), previous);
    } catch (error) {
      // A missing file is normal on the first run. Never replace a valid backup
      // with a malformed current file.
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  await replaceFile(filePath, contents);
}

async function readBackupOrFallback(filePath, fallback) {
  try {
    const recovered = JSON.parse(await readFile(backupPath(filePath), 'utf8'));
    console.warn(`Recovered missing ${filePath} from its last valid backup.`);
    return recovered;
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw invalidJsonError(backupPath(filePath), error);
  }
}

async function replaceFile(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function backupPath(filePath) {
  return `${filePath}.bak`;
}

function invalidJsonError(filePath, error, backupError) {
  const detail = backupError
    ? `; backup is also unusable (${backupError.message})`
    : '';
  return new Error(`Cannot read valid JSON from ${filePath}: ${error.message}${detail}`, {
    cause: error,
  });
}
