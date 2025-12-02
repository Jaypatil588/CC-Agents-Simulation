import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { insertInput } from './aiTown/insertInput';
import { conversationId, playerId } from './aiTown/ids';
import { internal } from './_generated/api';

export const listMessages = query({
  args: {
    worldId: v.id('worlds'),
    conversationId,
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query('messages')
      .withIndex('conversationId', (q) => q.eq('worldId', args.worldId).eq('conversationId', args.conversationId))
      .collect();
    const out = [];
    for (const message of messages) {
      const playerDescription = await ctx.db
        .query('playerDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', message.author))
        .first();
      if (!playerDescription) {
        throw new Error(`Invalid author ID: ${message.author}`);
      }
      out.push({ ...message, authorName: playerDescription.name });
    }
    return out;
  },
});

export const writeMessage = mutation({
  args: {
    worldId: v.id('worlds'),
    conversationId,
    messageUuid: v.string(),
    playerId,
    text: v.string(),
  },
  handler: async (ctx, args) => {
    // Get player name for terminal logging
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    
    const playerName = playerDescription?.name || args.playerId;
    
    // Log to terminal
    console.log(`[${new Date().toLocaleTimeString()}] 💬 ${playerName}: ${args.text}`);
    
    const messageDoc = await ctx.db.insert('messages', {
      conversationId: args.conversationId,
      author: args.playerId,
      messageUuid: args.messageUuid,
      text: args.text,
      worldId: args.worldId,
    });
    
    // Note: Cannot schedule from mutation context, but messages from human players
    // will be picked up by the cron job that scans for unprocessed messages
    
    await insertInput(ctx, args.worldId, 'finishSendingMessage', {
      conversationId: args.conversationId,
      playerId: args.playerId,
      timestamp: Date.now(),
    });
  },
});

// Query to get most recent message for a player from active conversations
export const getMostRecentMessage = query({
  args: {
    worldId: v.id('worlds'),
    playerId: playerId,
  },
  handler: async (ctx, args) => {
    // Get all messages by this player from conversations in this world
    // We need to query by conversationId index and filter
    const allMessages: any[] = [];
    
    // Get all conversations for this world (we'll need to query messages by worldId)
    // Since we don't have a direct worldId index on messages, we'll query all and filter
    // This is not ideal but works for now
    const messages = await ctx.db
      .query('messages')
      .filter((q) => q.eq(q.field('worldId'), args.worldId))
      .collect();
    
    // Filter by author and get most recent
    const playerMessages = messages
      .filter((m) => m.author === args.playerId)
      .sort((a, b) => b._creationTime - a._creationTime);
    
    if (playerMessages.length === 0) {
      return null;
    }
    
    const message = playerMessages[0];
    
    // Get player name
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    
    return {
      text: message.text,
      timestamp: message._creationTime,
      authorName: playerDescription?.name || 'Unknown',
    };
  },
});
