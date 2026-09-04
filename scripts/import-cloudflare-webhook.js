import { readFile } from 'node:fs/promises';
import { privateDecrypt, constants } from 'node:crypto';
import { spawn } from 'node:child_process';
import { normalizeDiscordWebhook } from '../src/discord.js';

// No secret values are written to files, command arguments, or console output.
const [artifactDirectory] = process.argv.slice(2);
if (!artifactDirectory) throw new Error('Provide the downloaded encrypted export directory');
const privateKey = await readFile('.cloudflare-migration/export-private.pem');
const encrypted = await readFile(`${artifactDirectory}/webhook.enc`);
let webhook;
try {
  webhook = normalizeDiscordWebhook(privateDecrypt({
    key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256',
  }, encrypted).toString('utf8'));
} catch {
  throw new Error('The encrypted webhook could not be decrypted with this migration key');
}
if (!webhook) throw new Error('The exported Discord webhook is invalid');
const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', 'DISCORD_WEBHOOK'], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(webhook);
await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Secret registration failed (${code})`)));
});
