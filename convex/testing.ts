import { Id, TableNames } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  DatabaseReader,
  internalAction,
  internalMutation,
  mutation,
  query,
} from './_generated/server';
import { v } from 'convex/values';
import schema from './schema';
import { DELETE_BATCH_SIZE } from './constants';
import { kickEngine, startEngine, stopEngine } from './aiTown/main';
import { insertInput } from './aiTown/insertInput';
import { fetchEmbedding } from './util/llm';
import { chatCompletion } from './util/llm';
import { startConversationMessage } from './agent/conversation';
import { GameId } from './aiTown/ids';

// Clear all of the tables except for the embeddings cache.
const excludedTables: Array<TableNames> = ['embeddingsCache'];

export const wipeAllTables = internalMutation({
  handler: async (ctx) => {
    for (const tableName of Object.keys(schema.tables)) {
      if (excludedTables.includes(tableName as TableNames)) {
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.testing.deletePage, { tableName, cursor: null });
    }
  },
});

export const deletePage = internalMutation({
  args: {
    tableName: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { tableName, cursor }) => {
    const results = await ctx.db
      .query(tableName as TableNames)
      .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
    for (const row of results.page) {
      await ctx.db.delete(row._id);
    }
    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.testing.deletePage, {
        tableName,
        cursor: results.continueCursor,
      });
    }
  },
});

// Emergency cleanup: Delete old data from specific tables to reduce DB size
export const emergencyCleanup = internalMutation({
  args: {},
  handler: async (ctx, args) => {
    const ONE_DAY_AGO = Date.now() - (24 * 60 * 60 * 1000);
    const tablesToClean = ['messages', 'worldStory', 'inputs', 'memories', 'memoryEmbeddings'] as TableNames[];
    
    let totalDeleted = 0;
    
    for (const tableName of tablesToClean) {
      try {
        let deleted = 0;
        let cursor: string | null = null;
        
        do {
          const results = await ctx.db
            .query(tableName)
            .filter((q: any) => q.lt(q.field('_creationTime'), ONE_DAY_AGO))
            .paginate({ cursor, numItems: DELETE_BATCH_SIZE });
          
          for (const row of results.page) {
            await ctx.db.delete(row._id);
            deleted++;
          }
          
          cursor = results.isDone ? null : results.continueCursor;
        } while (cursor);
        
        console.log(`[emergencyCleanup] Deleted ${deleted} entries from ${tableName}`);
        totalDeleted += deleted;
      } catch (error: any) {
        console.error(`[emergencyCleanup] Error cleaning ${tableName}:`, error.message);
      }
    }
    
    return { success: true, totalDeleted };
  },
});

async function getDefaultWorld(db: DatabaseReader) {
  const worldStatus = await db
    .query('worldStatus')
    .filter((q) => q.eq(q.field('isDefault'), true))
    .first();
  if (!worldStatus) {
    throw new Error('No default world found');
  }
  const engine = await db.get(worldStatus.engineId);
  if (!engine) {
    throw new Error(`Engine ${worldStatus.engineId} not found`);
  }
  return { worldStatus, engine };
}

export const stopAllowed = query({
  handler: async () => {
    return !process.env.STOP_NOT_ALLOWED;
  },
});

export const stop = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    if (process.env.STOP_NOT_ALLOWED) throw new Error('Stop not allowed');
    await stopEngine(ctx, args.worldId);
  },
});

export const resume = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    await startEngine(ctx, args.worldId);
  },
});

export const kick = mutation({
  args: { worldId: v.id('worlds') },
  handler: async (ctx, args) => {
    await kickEngine(ctx, args.worldId);
  },
});
