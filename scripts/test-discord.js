const webhook = process.env.DISCORD_WEBHOOK || '';

if (!webhook) {
  throw new Error('DISCORD_WEBHOOK secret is not set.');
}

const response = await fetch(webhook, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    content: null,
    embeds: [
      {
        title: 'Nike Restock Notifier test',
        description: 'Discord webhook is configured correctly.',
        color: 0x2f7d4a,
        timestamp: new Date().toISOString(),
      },
    ],
  }),
});

if (!response.ok) {
  throw new Error(`Discord test failed: ${response.status} ${response.statusText}`);
}

console.log('Discord test notification sent.');
