import { v } from 'convex/values';
import { internal } from './_generated/api';
import { DatabaseReader, MutationCtx, mutation } from './_generated/server';
import { Descriptions } from '../data/characters';
import * as map from '../data/gentle';
import { insertInput } from './aiTown/insertInput';
import { Id } from './_generated/dataModel';
import { createEngine } from './aiTown/main';
import { ENGINE_ACTION_DURATION } from './constants';
import { detectMismatchedLLMProvider } from './util/llm';

const init = mutation({
  args: {
    numAgents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    detectMismatchedLLMProvider();
    const { worldStatus, engine } = await getOrCreateDefaultWorld(ctx);
    if (worldStatus.status !== 'running') {
      console.warn(
        `Engine ${engine._id} is not active! Run "npx convex run testing:resume" to restart it.`,
      );
      return;
    }
    const shouldCreate = await shouldCreateAgents(
      ctx.db,
      worldStatus.worldId,
      worldStatus.engineId,
    );
    if (shouldCreate) {
      // First, generate character descriptions with traits and species
      await ctx.scheduler.runAfter(0, internal.characterGeneration.generateCharacterDescriptions, {
        worldId: worldStatus.worldId,
      });
      
      // Then create 3 agents (wait a bit for generation to complete) - 3 AI agents + 1 player = 4 total
      const NUM_AGENTS = 3;
      await ctx.scheduler.runAfter(1000, internal.init.createAgentsAfterGeneration, {
        worldId: worldStatus.worldId,
        numAgents: args.numAgents !== undefined ? args.numAgents : NUM_AGENTS,
      });
    }
  },
});
export default init;

async function getOrCreateDefaultWorld(ctx: MutationCtx) {
  const now = Date.now();

  let worldStatus = await ctx.db
    .query('worldStatus')
    .filter((q) => q.eq(q.field('isDefault'), true))
    .unique();
  if (worldStatus) {
    const engine = (await ctx.db.get(worldStatus.engineId))!;
    return { worldStatus, engine };
  }

  const engineId = await createEngine(ctx);
  const engine = (await ctx.db.get(engineId))!;
  const worldId = await ctx.db.insert('worlds', {
    nextId: 0,
    agents: [],
    conversations: [],
    players: [],
  });
  const worldStatusId = await ctx.db.insert('worldStatus', {
    engineId: engineId,
    isDefault: true,
    lastViewed: now,
    status: 'running',
    worldId: worldId,
  });
  worldStatus = (await ctx.db.get(worldStatusId))!;
  await ctx.db.insert('maps', {
    worldId,
    width: map.mapwidth,
    height: map.mapheight,
    tileSetUrl: map.tilesetpath,
    tileSetDimX: map.tilesetpxw,
    tileSetDimY: map.tilesetpxh,
    tileDim: map.tiledim,
    bgTiles: map.bgtiles,
    objectTiles: map.objmap,
    animatedSprites: map.animatedsprites,
  });
  await ctx.scheduler.runAfter(0, internal.aiTown.main.runStep, {
    worldId,
    generationNumber: engine.generationNumber,
    maxDuration: ENGINE_ACTION_DURATION,
  });
  return { worldStatus, engine };
}

async function shouldCreateAgents(
  db: DatabaseReader,
  worldId: Id<'worlds'>,
  engineId: Id<'engines'>,
) {
  const world = await db.get(worldId);
  if (!world) {
    throw new Error(`Invalid world ID: ${worldId}`);
  }
  if (world.agents.length > 0) {
    return false;
  }
  const unactionedJoinInputs = await db
    .query('inputs')
    .withIndex('byInputNumber', (q) => q.eq('engineId', engineId))
    .order('asc')
    .filter((q) => q.eq(q.field('name'), 'createAgent'))
    .filter((q) => q.eq(q.field('returnValue'), undefined))
    .collect();
  if (unactionedJoinInputs.length > 0) {
    return false;
  }
  return true;
}

// Create agents after character generation completes
export const createAgentsAfterGeneration = mutation({
  args: {
    worldId: v.id('worlds'),
    numAgents: v.number(),
  },
  handler: async (ctx, args) => {
    // Get generated character descriptions
    const descriptions = await ctx.db
      .query('characterDescriptions')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .collect();
    
    if (!descriptions || descriptions.length === 0) {
      console.warn('[createAgentsAfterGeneration] No character descriptions found, waiting...');
      // Retry after 2 seconds
      await ctx.scheduler.runAfter(2000, internal.init.createAgentsAfterGeneration, args);
      return;
    }
    
    const sortedDescriptions = descriptions.sort((a: any, b: any) => a.characterIndex - b.characterIndex);
    const toCreate = Math.min(args.numAgents, sortedDescriptions.length);
    
    for (let i = 0; i < toCreate; i++) {
      const desc = sortedDescriptions[i];
      const characterName = `f${desc.characterIndex + 1}`;
      await insertInput(ctx, args.worldId, 'createAgent', {
        name: desc.name,
        character: characterName,
        identity: desc.identity,
        plan: desc.plan,
        species: desc.species,
      });
    }
  },
});
