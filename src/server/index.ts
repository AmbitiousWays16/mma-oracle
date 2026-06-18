import { Devvit, Context } from '@devvit/public-api';
import { Hono } from 'hono';
import { redis } from '@devvit/redis';

const app = new Hono();

/* -------------------------
   0. Nonblocking OnAppInstall
   ------------------------- */
export async function onAppInstall(_ctx: Context) {
  console.log('OnAppInstall start', new Date().toISOString());
  try {
    setTimeout(async () => {
      try {
        console.log('Background install work started', new Date().toISOString());
        console.log('Background install work finished', new Date().toISOString());
      } catch (bgErr) {
        console.error('Background install work failed', bgErr);
      }
    }, 0);

    console.log('OnAppInstall quick return', new Date().toISOString());
    return { success: true };
  } catch (err) {
    console.error('OnAppInstall error', err);
    throw err;
  }
}

/* -------------------------
   1. Bet placement route with logging and defensive Redis usage
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
    console.log('Checking lockKey', lockKey);
    const isLocked = await redis.get(lockKey);
    if (isLocked === 'true') {
      console.info('Wagers locked for event', eventId);
      return c.json({ success: false, error: 'Wagers are officially locked for this event.' }, 403);
    }

    const balanceKey = `user:${userId}:balance`;
    const betKey = `bet:${eventId}:${userId}`;

    console.log('Starting optimistic transaction for', balanceKey);
    // Defensive: ensure redis.watch returns a transaction-like object for your client
    const txn = await redis.watch(balanceKey);
    if (!txn) {
      console.error('Redis watch failed or returned falsy txn');
      return c.json({ success: false, error: 'Internal Server Error' }, 500);
    }

    try {
      const currentRaw = (await txn.get(balanceKey)) as unknown as string | null;
      const currentBalance = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
      console.log('Current balance', currentBalance);

      if (currentBalance < stake) {
        await txn.unwatch();
        console.info('Insufficient balance', { userId, currentBalance, stake });
        return c.json({ success: false, error: 'Insufficient community tokens.' }, 400);
      }

      await txn.multi();
      await txn.set(balanceKey, String(currentBalance - stake));
      await txn.set(betKey, JSON.stringify({ fighterId, method, round, stake, timestamp: Date.now() }));

      const result = await txn.exec();
      if (result === null) {
        console.warn('Transaction collision for', balanceKey);
        return c.json({ success: false, error: 'Transaction collision. Please try again.' }, 409);
      }

      console.log('Transaction success', { userId, newBalance: currentBalance - stake });
      return c.json({ success: true, newBalance: currentBalance - stake });
    } catch (txnErr) {
      console.error('Transaction error', txnErr);
      try { await txn.unwatch(); } catch (uErr) { console.error('unwatch failed', uErr); }
      return c.json({ success: false, error: 'Internal Server Error' }, 500);
    }
  } catch (error) {
    console.error('Bet placement failed:', error);
    return c.json({ success: false, error: 'Internal Server Error' }, 500);
  }
});

/* -------------------------
   2. Register scheduler job defensively
   ------------------------- */
try {
  Devvit.addSchedulerJob({
    name: 'lock_wagers',
    onRun: async (event, context) => {
      const { eventId } = event.data as { eventId: string };
      const lockKey = `event:${eventId}:locked`;
      console.log('lock_wagers onRun start', eventId, new Date().toISOString());
      try {
        await context.redis.set(lockKey, 'true');
        console.log(`Successfully locked wagers for event: ${eventId}`);
      } catch (error) {
        console.error(`Failed to lock wagers for ${eventId}:`, error);
      }
    },
  });
  console.log('Scheduler job registered: lock_wagers');
} catch (err) {
  console.error('Failed to register scheduler job', err);
}

/* -------------------------
   3. Register moderator menu defensively
   ------------------------- */
try {
  Devvit.addMenuItem({
    location: 'subreddit',
    label: 'Oracle: Schedule Saturday Lock',
    forUserType: 'moderator',
    onPress: async (_event, context) => {
      console.log('Menu onPress invoked', new Date().toISOString());
      const eventId = 'ufc_300';
      const lockTime = new Date('2026-06-20T18:00:00.000Z');

      try {
        await context.scheduler.runJob({
          name: 'lock_wagers',
          data: { eventId },
          runAt: lockTime,
        });
        context.ui.showToast(`Wagers scheduled to lock at ${lockTime.toLocaleString()}`);
        console.log('Scheduled lock_wagers', { eventId, lockTime: lockTime.toISOString() });
      } catch (err) {
        console.error('Failed to schedule job from menu', err);
        context.ui.showToast('Failed to schedule wager lock. See logs.');
      }
    },
  });
  console.log('Menu item registered');
} catch (err) {
  console.error('Failed to register menu item', err);
}

export default app;
