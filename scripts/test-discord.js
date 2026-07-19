import { normalizeDiscordWebhook, postDiscordWebhook } from '../src/discord.js';

const webhook = normalizeDiscordWebhook(process.env.DISCORD_WEBHOOK || '');

if (!webhook) {
  throw new Error('DISCORD_WEBHOOK secret is missing or invalid.');
}

await postDiscordWebhook(webhook, {
  content: null,
  allowed_mentions: { parse: [] },
  embeds: [
    {
      title: 'Nike Restock Notifier test',
      description: 'Discord webhook is configured correctly.',
      color: 0x2f7d4a,
      timestamp: new Date().toISOString(),
    },
  ],
});

console.log('Discord test notification sent.');
