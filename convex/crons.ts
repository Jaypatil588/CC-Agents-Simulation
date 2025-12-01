import { cronJobs } from 'convex/server';
import { DELETE_BATCH_SIZE, IDLE_WORLD_TIMEOUT, VACUUM_MAX_AGE } from './constants';
import { internal } from './_generated/api';
import { internalMutation } from './_generated/server';
import { TableNames } from './_generated/dataModel';
import { v } from 'convex/values';

const crons = cronJobs();

crons.interval(
  'stop inactive worlds',
  { seconds: IDLE_WORLD_TIMEOUT / 1000 },
  internal.world.stopInactiveWorlds,
);

crons.interval('restart dead worlds', { seconds: 60 }, internal.world.restartDeadWorlds);

// Initialize plots for new worlds
crons.interval('initialize world plots', { seconds: 15 }, internal.crons.initializeWorldPlots);

// Story generation and plot summaries are now event-driven (triggered by conversation completion)


// Vacuum old entries every 6 hours to prevent database from growing too large
crons.interval('vacuum old entries', { hours: 6 }, internal.crons.vacuumOldEntries);

export default crons;

const TablesToVacuum: TableNames[] = [
  // Vacuum old messages and conversations to prevent database bloat
  'messages',
  'archivedConversations',
  
  // Vacuum old story entries (keep only recent ones)
  'worldStory',
  
  // Inputs aren't useful unless you're trying to replay history
  'inputs',

  // We can keep memories without their embeddings for inspection, but we won't
  // retrieve them when searching memories via vector search.
  'memories',
  // We can vacuum fewer tables without serious consequences, but the only
  // one that will cause issues over time is having >>100k vectors.
  'memoryEmbeddings',
];

// Initialize plots for worlds that don't have them
export const initializeWorldPlots = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const worlds = await ctx.db.query('worlds').collect();
    
    for (const world of worlds) {
      const existingPlot = await ctx.db
        .query('worldPlot')
        .withIndex('worldId', (q) => q.eq('worldId', world._id))
        .first();
      
      if (!existingPlot) {
        // Initialize plot for this world (run as action)
        console.log(`Initializing plot for world ${world._id}`);
        await ctx.scheduler.runAfter(0, internal.worldStory.initializeWorldPlot, {
          worldId: world._id,
        });
      }
    }
  },
});

// Story generation and plot summaries are now event-driven
// Removed cron-based generation - see worldStory.ts for event-driven triggers


export const vacuumOldEntries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const before = Date.now() - VACUUM_MAX_AGE;
    for (const tableName of TablesToVacuum) {
      console.log(`Checking ${tableName}...`);
      try {
        // Use filter instead of index since most tables don't have by_creation_time index
        const exists = await ctx.db
          .query(tableName)
          .filter((q: any) => q.lt(q.field('_creationTime'), before))
          .first();
        if (exists) {
          console.log(`Vacuuming ${tableName}...`);
          await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
            tableName,
            before,
            cursor: null,
            soFar: 0,
          });
        }
      } catch (error: any) {
        console.log(`Skipping ${tableName} - ${error.message || 'error'}`);
      }
    }
  },
});

export const vacuumTable = internalMutation({
  args: {
    tableName: v.string(),
    before: v.number(),
    cursor: v.union(v.string(), v.null()),
    soFar: v.number(),
  },
  handler: async (ctx, { tableName, before, cursor, soFar }) => {
    // Try to use index if available, otherwise use filter
    let results;
    try {
      results = await ctx.db
        .query(tableName as TableNames)
        .withIndex('by_creation_time', (q: any) => q.lt('_creationTime', before))
        .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    } catch (error: any) {
      // Fallback to filter if index doesn't exist
      const allOld = await ctx.db
        .query(tableName as TableNames)
        .filter((q: any) => q.lt(q.field('_creationTime'), before))
        .take(DELETE_BATCH_SIZE);
      
      results = {
        page: allOld,
        continueCursor: allOld.length === DELETE_BATCH_SIZE ? 'continue' : null,
        isDone: allOld.length < DELETE_BATCH_SIZE,
      };
    }
    
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone && results.continueCursor) {
      await ctx.scheduler.runAfter(0, internal.crons.vacuumTable, {
        tableName,
        before,
        soFar: results.page.length + soFar,
        cursor: results.continueCursor,
      });
    } else {
      console.log(`Vacuumed ${soFar + results.page.length} entries from ${tableName}`);
    }
  },
});
