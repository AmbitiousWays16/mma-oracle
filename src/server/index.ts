import { Context } from '@devvit/public-api';
import { Hono } from 'hono';
import { redis, scheduler } from '@devvit/web/server';

const app = new Hono();

/* -------------------------
   0. Nonblocking OnAppInstall
   ------------------------- */
export async function onAppInstall(_ctx: Context) {
  console.log('OnAppInstall start', new Date().toISOString());
  console.log('OnAppInstall complete', new Date().toISOString());
  return { success: true };
}

/* -------------------------
   1. OnAppInstall trigger
   ------------------------- */
app.post('/internal/triggers/on-app-install', async (c) => {
  console.log('OnAppInstall start', new Date().toISOString());
  console.log('OnAppInstall complete', new Date().toISOString());
  return c.json({ success: true });
});

/* -------------------------
   2. Bet placement route
   ------------------------- */
app.post('/api/place-bet', async (c) => {
  console.log('place-bet called', new Date().toISOString());
  try {
    const { eventId, fighterId, method, round, stake } = await c.req.json();
    const userId = c.req.header('x-reddit-user-id');

    if (!userId) {
      console.warn('Unauthorized request: missing user id');
      return c.json({ success: false, error: 'Unauthorized user.' }, 401);
    }

    const lockKey = `event:${eventId}:locked`;
    const isLocked = await redis.get(lockKey);
    if (isLocked === 'true') {
      return c.json({ success: false, error: 'Wagers are officially locked for this event.' }, 403);
    }

    const balanceKey = `user:${userId}:balance`;
    const betKey = `bet:${eventId}:${userId}`;

    const currentRaw = await redis.get(balanceKey);
    const currentBalance = currentRaw ? Number.parseInt(currentRaw, 10) : 0;

    if (currentBalance < stake) {
      return c.json({ success: false, error: 'Insufficient community tokens.' }, 400);
    }

    await redis.set(balanceKey, String(currentBalance - stake));
    await redis.set(betKey, JSON.stringify({ fighterId, method, round, stake, timestamp: Date.now() }));

    return c.json({ success: true, newBalance: currentBalance - stake });
  } catch (error) {
    console.error('Bet placement failed:', error);
    return c.json({ success: false, error: 'Internal Server Error' }, 500);
  }
});

/* -------------------------
   3. Lock wagers route (called by scheduler)
   ------------------------- */
app.post('/api/lock-wagers', async (c) => {
  try {
    const { eventId } = await c.req.json();
    const lockKey = `event:${eventId}:locked`;
    await redis.set(lockKey, 'true');
    console.log(`Successfully locked wagers for event: ${eventId}`);
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to lock wagers:', error);
    return c.json({ success: false, error: 'Internal Server Error' }, 500);
  }
});

/* -------------------------
   4. Schedule wager lock route
   ------------------------- */
app.post('/api/schedule-lock', async (c) => {
  try {
    const { eventId, lockTime } = await c.req.json();
    await scheduler.runJob({
      name: 'lock_wagers',
      data: { eventId },
      runAt: new Date(lockTime),
    });
    console.log('Scheduled lock_wagers', { eventId, lockTime });
    return c.json({ success: true });
  } catch (error) {
    console.error('Failed to schedule lock:', error);
    return c.json({ success: false, error: 'Internal Server Error' }, 500);
  }
});

export { app };
