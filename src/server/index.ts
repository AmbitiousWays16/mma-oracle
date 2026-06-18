import { Devvit } from '@devvit/public-api';
import { Hono } from 'hono';
import { redis } from '@devvit/redis';

// 1. Initialize the Hono router for the Devvit server
const app = new Hono();

// 2. The unified Bet Placement Route (Includes Lock Check + Transaction)
app.post('/api/place-bet', async (c) => {
  try {
    const { eventId, fighterId, method, round, stake } = await c.req.json();
    const userId = c.req.header('x-reddit-user-id');
    
    if (!userId) {
      return c.json({ success: false, error: 'Unauthorized user.' }, 401);
    }

    // STEP A: Check if wagers are already locked for this event
    const lockKey = `event:${eventId}:locked`;
    const isLocked = await redis.get(lockKey);
    if (isLocked === 'true') {
      return c.json({ success: false, error: 'Wagers are officially locked for this event.' }, 403);
    }

    const balanceKey = `user:${userId}:balance`;
    const betKey = `bet:${eventId}:${userId}`;

    // STEP B: Execute the Atomic Transaction to prevent double-charging
    const txn = await redis.watch(balanceKey);
   const currentRaw = (await txn.get(balanceKey)) as unknown as string | null;
    const currentBalance = currentRaw ? Number.parseInt(currentRaw, 10) : 0;

    if (currentBalance < stake) {
      await txn.unwatch();
      return c.json({ success: false, error: 'Insufficient community tokens.' }, 400);
    }

    await txn.multi();
    await txn.set(balanceKey, String(currentBalance - stake));
    
    await txn.set(betKey, JSON.stringify({ 
      fighterId, 
      method, 
      round, 
      stake,
      timestamp: Date.now()
    }));
    
    const result = await txn.exec();

    if (result === null) {
      return c.json({ success: false, error: 'Transaction collision. Please try again.' }, 409);
    }

    return c.json({ success: true, newBalance: currentBalance - stake });

  } catch (error) {
    console.error('Bet placement failed:', error);
    return c.json({ success: false, error: 'Internal Server Error' }, 500);
  }
});

// 3. Register the background job for the Devvit Scheduler
Devvit.addSchedulerJob({
  name: 'lock_wagers',
  onRun: async (event, context) => {
    const { eventId } = event.data as { eventId: string };
    const lockKey = `event:${eventId}:locked`;
    
    try {
      await context.redis.set(lockKey, 'true');
      console.log(`Successfully locked wagers for event: ${eventId}`);
    } catch (error) {
      console.error(`Failed to lock wagers for ${eventId}:`, error);
    }
  },
});

// 4. Create a Moderator Menu to queue the Saturday Lock
Devvit.addMenuItem({
  location: 'subreddit',
  label: 'Oracle: Schedule Saturday Lock',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const eventId = "ufc_300"; // Dynamic in production
    const lockTime = new Date('2026-06-20T18:00:00.000Z'); 

    // Correctly call the schedule method
    await context.scheduler.runJob({
  name: 'lock_wagers',
  data: { eventId: eventId },
  runAt: lockTime
    });

    context.ui.showToast(`Wagers scheduled to lock at ${lockTime.toLocaleString()}`);
  },
});

// 5. Export the Hono app for Devvit to mount
export default app;