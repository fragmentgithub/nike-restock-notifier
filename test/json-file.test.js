import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonFile, writeJsonFileAtomic } from '../src/json-file.js';

test('JSONを置換し、直前の有効な状態をバックアップする', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'state.json');

  await writeJsonFileAtomic(filePath, { version: 1 });
  await writeJsonFileAtomic(filePath, { version: 2 });

  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(`${filePath}.bak`, 'utf8')), { version: 1 });
});

test('現在のJSONが壊れていれば直前の有効な状態から復旧する', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'state.json');

  await writeJsonFileAtomic(filePath, { version: 1 });
  await writeJsonFileAtomic(filePath, { version: 2 });
  await writeFile(filePath, '{broken', 'utf8');

  assert.deepEqual(await readJsonFile(filePath, {}), { version: 1 });
});

test('バックアップのない破損JSONを空状態として扱わない', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = join(directory, 'state.json');
  await writeFile(filePath, '{broken', 'utf8');

  await assert.rejects(readJsonFile(filePath, {}), /Cannot read valid JSON/);
});

test('初回実行で状態ファイルがなければ指定した初期値を返す', async (t) => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await readJsonFile(join(directory, 'missing.json'), { fresh: true }), {
    fresh: true,
  });
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nike-json-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
