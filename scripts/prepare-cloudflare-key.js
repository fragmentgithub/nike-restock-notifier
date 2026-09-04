import { mkdir, access, writeFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';

await mkdir('.cloudflare-migration', { recursive: true });
const privatePath = '.cloudflare-migration/export-private.pem';
try {
  await access(privatePath);
  console.log('Existing migration key retained.');
} catch {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await writeFile(privatePath, pair.privateKey, { mode: 0o600 });
  await writeFile('.cloudflare-migration/export-public.pem', pair.publicKey);
  console.log('Migration encryption key prepared; private key stays on this computer.');
}
