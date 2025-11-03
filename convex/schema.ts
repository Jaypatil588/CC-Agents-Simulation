import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { agentTables } from './agent/schema';
import { aiTownTables } from './aiTown/schema';
import { conversationId, playerId } from './aiTown/ids';
import { engineTables } from './engine/schema';

export default defineSchema({
  music: defineTable({
    storageId: v.string(),
    type: v.union(v.literal('background'), v.literal('player')),
  }),

  messages: defineTable({
    conversationId,
    messageUuid: v.string(),
    author: playerId,
    text: v.string(),
    worldId: v.optional(v.id('worlds')),
  })
    .index('conversationId', ['worldId', 'conversationId'])
    .index('messageUuid', ['conversationId', 'messageUuid']),

  worldStory: defineTable({
    worldId: v.id('worlds'),
    narrative: v.string(),
    conflictType: v.optional(v.string()), // 'confrontation', 'alliance', 'betrayal', 'quest', 'mystery', etc.
    sourceMessages: v.array(v.id('messages')),
    characterNames: v.array(v.string()),
    timestamp: v.number(),
  })
    .index('worldId', ['worldId', 'timestamp']),

  worldPlot: defineTable({
    worldId: v.id('worlds'),
    initialPlot: v.string(), // The original epic DnD plot generated on startup
    currentSummary: v.string(), // Latest plot summary (updated every 10s)
    lastProcessedMessageTime: v.number(), // Track which messages we've processed
    storyProgress: v.string(), // Current state of the story (beginning, rising, climax, etc)
    lastSummaryTime: v.number(), // When we last generated a summary
  })
    .index('worldId', ['worldId']),

  ...agentTables,
  ...aiTownTables,
  ...engineTables,
});
