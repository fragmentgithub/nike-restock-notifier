import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discordAllowedMentions,
  normalizeDiscordMention,
  normalizeDiscordWebhook,
  postDiscordWebhook,
  scrubDiscordWebhook,
} from '../src/discord.js';

const WEBHOOK = 'https://discord.com/api/webhooks/123456/token-value';

test('Discord公式HTTPSのWebhookだけを受け付ける', () => {
  assert.equal(normalizeDiscordWebhook(WEBHOOK), WEBHOOK);
  assert.equal(normalizeDiscordWebhook(WEBHOOK.replace('https:', 'http:')), '');
  assert.equal(normalizeDiscordWebhook('https://example.com/api/webhooks/123456/token-value'), '');
  assert.equal(normalizeDiscordWebhook('https://discord.com/channels/1/2'), '');
});

test('Discordメンションを許可対象IDへ限定する', () => {
  assert.equal(normalizeDiscordMention('<@&12345>'), '<@&12345>');
  assert.equal(normalizeDiscordMention('<@!67890>'), '<@!67890>');
  assert.equal(normalizeDiscordMention('@everyone'), '');
  assert.deepEqual(discordAllowedMentions('<@&12345>'), { parse: [], roles: ['12345'] });
  assert.deepEqual(discordAllowedMentions('<@!67890>'), { parse: [], users: ['67890'] });
  assert.deepEqual(discordAllowedMentions('@everyone'), { parse: [] });
});

test('Webhook送信を共通処理でJSON化し、秘密URLをログから除去する', async () => {
  let request;
  await postDiscordWebhook(WEBHOOK, { content: 'test' }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(request.url, WEBHOOK);
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { content: 'test' });
  assert.equal(scrubDiscordWebhook(`failed: ${WEBHOOK}`, WEBHOOK), 'failed: [webhook]');
});
