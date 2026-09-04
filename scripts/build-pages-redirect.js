import { mkdir, writeFile } from 'node:fs/promises';

const target = 'https://nike-restock-notifier.only-this-moment.workers.dev/';
await mkdir('.github-pages-redirect', { recursive: true });
await writeFile('.github-pages-redirect/index.html', `<!doctype html>
<html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${target}"><title>Nike監視ページは移転しました</title>
<p>Nike監視ページはCloudflareへ移転しました。<a href="${target}">新しい監視ページを開く</a></p></html>\n`);
await writeFile('.github-pages-redirect/status.json', JSON.stringify({ migratedTo: `${target}status.json` }));
