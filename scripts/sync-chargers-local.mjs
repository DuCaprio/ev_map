import { setTimeout as delay } from 'node:timers/promises';

const secret = process.env.CRON_SECRET;
const port = process.env.CHARGER_SYNC_PORT ?? '3000';
const interval = Number(process.env.CHARGER_SYNC_INTERVAL_MS ?? 300_000);

if (!secret) throw new Error('Set CRON_SECRET in .env.local before starting charger sync.');
if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 600_000) {
  throw new Error('CHARGER_SYNC_INTERVAL_MS must be between 1000 and 600000.');
}

const endpoint = new URL(`http://127.0.0.1:${port}/api/cron/chargers`);
console.log(`Charger sync started. Interval: ${interval / 1000}s.`);

while (true) {
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${secret}` },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result.success) throw new Error('The sync endpoint did not report success.');
    console.log(`[${new Date().toISOString()}] Charger sync complete. Updated: ${result.updatedCount}.`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Charger sync failed: ${error.message}`);
  }
  await delay(Math.max(1_000, interval - (Date.now() - startedAt)));
}
