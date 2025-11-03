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

// Generate real-time story narratives every 5 seconds
crons.interval('generate world story', { seconds: 5 }, internal.crons.generateWorldStories);

// Generate plot summaries every 10 seconds for context
crons.interval('generate plot summaries', { seconds: 10 }, internal.crons.generatePlotSummaries);

crons.daily('vacuum old entries', { hourUTC: 4, minuteUTC: 20 }, internal.crons.vacuumOldEntries);

export default crons;

const TablesToVacuum: TableNames[] = [
  // Un-comment this to also clean out old conversations.
  // 'conversationMembers', 'conversations', 'messages',

  // Inputs aren't useful unless you're trying to replay history.
  // If you want to support that, you should add a snapshot table, so you can
  // replay from a certain time period. Or stop vacuuming inputs and replay from
  // the beginning of time
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

// Generate real-time story narratives
export const generateWorldStories = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const worlds = await ctx.db.query('worlds').collect();
    
    for (const world of worlds) {
      // Schedule story generation for this world (run as action)
      await ctx.scheduler.runAfter(0, internal.worldStory.generateNarrative, {
        worldId: world._id,
      });
    }
  },
});

// Generate plot summaries every 10 seconds
export const generatePlotSummaries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const worlds = await ctx.db.query('worlds').collect();
    
    for (const world of worlds) {
      // Schedule summary generation for this world (run as action)
      await ctx.scheduler.runAfter(0, internal.worldStory.generatePlotSummary, {
        worldId: world._id,
      });
    }
  },
});

export const vacuumOldEntries = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const before = Date.now() - VACUUM_MAX_AGE;
    for (const tableName of TablesToVacuum) {
      console.log(`Checking ${tableName}...`);
      const exists = await ctx.db
        .query(tableName)
        .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
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
    const results = await ctx.db
      .query(tableName as TableNames)
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', before))
      .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
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
