// Alerts go to Telegram and/or a generic JSON webhook (Discord, Slack, Google Chat, n8n...).
export function createNotifier(env = process.env) {
  const targets = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    targets.push(async ({ text }) => {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Telegram ตอบ ${res.status}`);
    });
  }

  if (env.WEBHOOK_URL) {
    targets.push(async ({ text, monitorId, status }) => {
      const res = await fetch(env.WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `text` suits Slack/Google Chat, `content` suits Discord.
        body: JSON.stringify({ text, content: text, monitor: monitorId, status }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`Webhook ตอบ ${res.status}`);
    });
  }

  return {
    enabled: targets.length > 0,
    async send(msg) {
      console.log(`[alert] ${msg.text.replace(/\n/g, ' | ')}`);
      const results = await Promise.allSettled(targets.map((t) => t(msg)));
      for (const r of results) if (r.status === 'rejected') console.error('notify failed:', r.reason.message);
    },
  };
}
