import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery, mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { chatCompletion } from './util/llm';
import {
  STORY_GENERATION_COOLDOWN,
  MIN_MESSAGES_FOR_STORY,
  MIN_MESSAGES_IN_CONVERSATION,
} from './constants';

// Maximum number of story passages before completion
const MAX_PASSAGES = 12;

// Query to get world story entries for a specific world
export const getWorldStory = query({
  args: {
    worldId: v.id('worlds'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 200;
    const entries = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(limit);
    
    return entries.reverse(); // Return in chronological order
  },
});

// Query to get the world plot (initial plot + current summary)
export const getWorldPlot = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    return plot;
  },
});

// Internal query to get characters for plot generation  
export const getCharacters = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const characters = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    return characters;
  },
});

// Internal mutation to create world plot
export const createWorldPlot = internalMutation({
  args: {
    worldId: v.id('worlds'),
    initialPlot: v.string(),
    currentSummary: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[createWorldPlot] Inserting plot for world ${args.worldId}`);
    
    // Final check to prevent duplicates (race condition protection)
    const existingPlot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (existingPlot) {
      console.log(`[createWorldPlot] Plot already exists with ID: ${existingPlot._id}, skipping insert`);
      return existingPlot._id;
    }
    
    console.log(`[createWorldPlot] Initial plot length: ${args.initialPlot.length} characters`);
    
    const plotId = await ctx.db.insert('worldPlot', {
      worldId: args.worldId,
      initialPlot: args.initialPlot,
      currentSummary: args.currentSummary,
      lastProcessedMessageTime: 0,
      processedMessageIds: [],
      lastStoryGenerationTime: undefined,
      storyProgress: 'beginning',
      lastSummaryTime: Date.now(),
    });
    
    console.log(`[createWorldPlot] Plot inserted successfully with ID: ${plotId}`);
    return plotId;
  },
});

// Public mutation to trigger plot initialization (called from frontend)
export const initializePlot = mutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Check if plot already exists
    const existingPlot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (existingPlot) {
      return existingPlot;
    }

    // Schedule internal initialization
    await ctx.scheduler.runAfter(0, internal.worldStory.initializeWorldPlot, {
      worldId: args.worldId,
    });

    return null;
  },
});

// Public mutation to reset/clear the story for a world
export const resetWorldStory = mutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    console.log(`[resetWorldStory] Starting reset for world ${args.worldId}`);
    
    // Delete all story entries for this world
    const storyEntries = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${storyEntries.length} story entries`);
    for (const entry of storyEntries) {
      await ctx.db.delete(entry._id);
    }

    // Delete ALL plot entries for this world (in case there are duplicates)
    const plots = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${plots.length} plot entries`);
    for (const plot of plots) {
      await ctx.db.delete(plot._id);
    }

    // Delete all messages/conversations for this world
    const messages = await ctx.db
      .query('messages')
      .filter((q) => q.eq(q.field('worldId'), args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${messages.length} messages`);
    for (const message of messages) {
      await ctx.db.delete(message._id);
    }

    // Delete all archived conversations for this world
    const archivedConversations = await ctx.db
      .query('archivedConversations')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${archivedConversations.length} archived conversations`);
    for (const archivedConv of archivedConversations) {
      await ctx.db.delete(archivedConv._id);
    }

    // Delete all participatedTogether entries for this world
    const participatedTogether = await ctx.db
      .query('participatedTogether')
      .withIndex('edge', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${participatedTogether.length} participatedTogether entries`);
    for (const entry of participatedTogether) {
      await ctx.db.delete(entry._id);
    }

    // Delete all archived players for this world
    const archivedPlayers = await ctx.db
      .query('archivedPlayers')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${archivedPlayers.length} archived players`);
    for (const archivedPlayer of archivedPlayers) {
      await ctx.db.delete(archivedPlayer._id);
    }

    // Delete character descriptions to force regeneration
    const characterDescriptions = await ctx.db
      .query('characterDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${characterDescriptions.length} character descriptions`);
    for (const charDesc of characterDescriptions) {
      await ctx.db.delete(charDesc._id);
    }

    // Delete old memories and embeddings for this world's agents
    // Get all agents for this world
    const world = await ctx.db.get(args.worldId);
    if (world && world.agents) {
      const agentIds = world.agents.map((a: any) => a.id);
      const playerIds = world.players.map((p: any) => p.id);
      
      // Delete memories and their associated embeddings for these players
      for (const playerId of playerIds) {
        const memories = await ctx.db
          .query('memories')
          .withIndex('playerId', (q: any) => q.eq('playerId', playerId))
          .collect();
        console.log(`[resetWorldStory] Deleting ${memories.length} memories for player ${playerId}`);
        
        // Collect embeddingIds from memories before deleting them
        const embeddingIds = new Set<Id<'memoryEmbeddings'>>();
        for (const memory of memories) {
          embeddingIds.add(memory.embeddingId);
          await ctx.db.delete(memory._id);
        }
        
        // Delete the associated memory embeddings
        for (const embeddingId of embeddingIds) {
          try {
            await ctx.db.delete(embeddingId);
          } catch (error: any) {
            // Embedding might already be deleted or not exist
            console.log(`[resetWorldStory] Could not delete embedding ${embeddingId}: ${error.message}`);
          }
        }
        console.log(`[resetWorldStory] Deleted ${embeddingIds.size} memory embeddings for player ${playerId}`);
      }
    }

    // Clean up old inputs and other accumulated data
    console.log(`[resetWorldStory] Cleaning up old inputs and accumulated data...`);
    await ctx.scheduler.runAfter(0, internal.crons.vacuumOldEntries, {});

    // Note: We don't need to clear completion status since we're deleting all plots
    // The new plot created by initializeWorldPlot will have isComplete/finalSummary as undefined

    // Reinitialize the plot
    await ctx.scheduler.runAfter(0, internal.worldStory.initializeWorldPlot, {
      worldId: args.worldId,
    });

    const totalDeleted = storyEntries.length + plots.length + messages.length + archivedConversations.length + participatedTogether.length + archivedPlayers.length + characterDescriptions.length;
    console.log(`[resetWorldStory] Reset complete. Deleted ${storyEntries.length} stories, ${plots.length} plots, ${messages.length} messages, ${archivedConversations.length} archived conversations, ${participatedTogether.length} participation records, ${archivedPlayers.length} archived players, ${characterDescriptions.length} character descriptions`);
    return { 
      success: true, 
      message: `Story reset successfully. Cleared ${totalDeleted} total entries (${messages.length} messages, ${storyEntries.length} story passages, ${plots.length} plots, ${archivedConversations.length} archived conversations, ${participatedTogether.length} participation records, ${archivedPlayers.length} archived players, ${characterDescriptions.length} character descriptions).` 
    };
  },
});

// Helper mutation to clean up duplicate plots (keep only the first one)
export const cleanupDuplicatePlots = mutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plots = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    if (plots.length <= 1) {
      return { success: true, message: `No duplicates found. ${plots.length} plot(s) exist.` };
    }

    // Keep the first one, delete the rest
    const [firstPlot, ...duplicates] = plots;
    
    for (const duplicate of duplicates) {
      await ctx.db.delete(duplicate._id);
    }

    return { 
      success: true, 
      message: `Cleaned up ${duplicates.length} duplicate plot(s). Kept plot ID: ${firstPlot._id}` 
    };
  },
});

// Initialize a world plot with an epic DnD story (internal action)
export const initializeWorldPlot = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    console.log(`[initializeWorldPlot] Starting for world ${args.worldId}`);
    
    // Check if plot already exists
    const existingPlot: any = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    
    if (existingPlot) {
      console.log(`[initializeWorldPlot] Plot already exists for world ${args.worldId}`);
      return existingPlot;
    }

    console.log(`[initializeWorldPlot] No existing plot, generating new one...`);

    // Get character descriptions to incorporate into the plot
    const characters: any = await ctx.runQuery(api.worldStory.getCharacters, {
      worldId: args.worldId,
    });
    
    const characterList = characters.map((c: any) => `${c.name}: ${c.description}`).join('\n');

    try {
      console.log(`[initializeWorldPlot] Calling LLM to generate plot...`);
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction writing - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose, not promoting real-world harm. Create dramatic plot with conflict, stakes, mystery.',
          },
          {
            role: 'user',
            content: `Create fictional D&D adventure plot for a storytelling game. Characters: ${characterList}. Write 3-4 paragraphs establishing world, central conflict, atmosphere.`,
          },
        ],
        temperature: 0.9,
        max_tokens: 100,
      });

      console.log(`[initializeWorldPlot] LLM response received, saving plot...`);
      console.log(`[initializeWorldPlot] Plot content: ${content.substring(0, 100)}...`);

      await ctx.runMutation(internal.worldStory.createWorldPlot, {
        worldId: args.worldId,
        initialPlot: content.trim(),
        currentSummary: content.trim(),
      });

      console.log(`[initializeWorldPlot] Plot saved successfully!`);
      return { success: true, plot: content.trim() };
    } catch (error) {
      console.error('[initializeWorldPlot] Failed to generate initial plot:', error);
      // Create a default plot if LLM fails
      const defaultPlot = `In a realm of magic and mystery, ancient forces stir. Dark omens have been reported across the land, and the inhabitants sense that great changes are coming. Alliances will be tested, secrets will be revealed, and heroes will rise to face the challenges ahead. The fate of the realm hangs in the balance.`;
      
      console.log(`[initializeWorldPlot] Using default plot due to error`);
      await ctx.runMutation(internal.worldStory.createWorldPlot, {
        worldId: args.worldId,
        initialPlot: defaultPlot,
        currentSummary: defaultPlot,
      });

      return { success: true, plot: defaultPlot };
    }
  },
});

// Generate emojis for conversations based on summaries (event-driven, separate from story generation)
export const generateConversationEmojisAction = internalAction({
  args: {
    worldId: v.id('worlds'),
    conversationSummaries: v.array(v.string()),
    characterNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    // Emoji generation is handled by existing frontend bubble system
    // This function is a placeholder for future refinement
    // The conversation summaries already contain enough context for emoji assignment
    // Can be enhanced later to generate emojis via LLM if needed
  },
});

// Check if story generation should be triggered (internal query)
export const shouldTriggerStoryGeneration = internalQuery({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();

    if (!plot) {
      return { shouldTrigger: false, reason: 'No plot found' };
    }

    // Check cooldown
    const now = Date.now();
    const lastGeneration = plot.lastStoryGenerationTime || 0;
    if (now - lastGeneration < STORY_GENERATION_COOLDOWN) {
      return {
        shouldTrigger: false,
        reason: `Cooldown active (${Math.round((STORY_GENERATION_COOLDOWN - (now - lastGeneration)) / 1000)}s remaining)`,
      };
    }

    // Get conversation stacks
    const stacks: Record<string, any[]> = plot.conversationStacks || {};
    const processedIds = new Set(plot.processedMessageIds || []);

    // Collect all unprocessed messages
    const allUnprocessedMessages: any[] = [];
    for (const [playerId, messages] of Object.entries(stacks)) {
      for (const msg of messages) {
        const msgIdStr = typeof msg.messageId === 'string' ? msg.messageId : msg.messageId.toString();
        if (!processedIds.has(msgIdStr)) {
          allUnprocessedMessages.push(msg);
        }
      }
    }

    // Check if we have enough new messages
    if (allUnprocessedMessages.length < MIN_MESSAGES_FOR_STORY) {
      return {
        shouldTrigger: false,
        reason: `Not enough new messages (${allUnprocessedMessages.length}/${MIN_MESSAGES_FOR_STORY})`,
      };
    }

    // Group by conversation and check for meaningful conversations
    const conversationGroups = new Map<string, any[]>();
    for (const msg of allUnprocessedMessages) {
      const convId = msg.conversationId?.toString() || 'unknown';
      if (!conversationGroups.has(convId)) {
        conversationGroups.set(convId, []);
      }
      conversationGroups.get(convId)!.push(msg);
    }

    // Check if we have at least one meaningful conversation (2+ messages)
    const meaningfulConversations = Array.from(conversationGroups.values()).filter(
      (msgs) => msgs.length >= MIN_MESSAGES_IN_CONVERSATION,
    );

    if (meaningfulConversations.length === 0) {
      return {
        shouldTrigger: false,
        reason: 'No meaningful conversations (need 2+ messages per conversation)',
      };
    }

    return {
      shouldTrigger: true,
      unprocessedMessageCount: allUnprocessedMessages.length,
      meaningfulConversationCount: meaningfulConversations.length,
    };
  },
});

// Internal mutation to push message to conversation stack
export const pushToConversationStackMutation = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
    messageId: v.id('messages'),
    messageText: v.string(),
    conversationId: v.string(),
    authorName: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();

    if (!plot) {
      return;
    }

    // Initialize stacks if not exists
    const stacks: Record<string, any[]> = plot.conversationStacks || {};
    if (!stacks[args.playerId]) {
      stacks[args.playerId] = [];
    }

    // Push message to player's stack
    stacks[args.playerId].push({
      messageId: args.messageId,
      text: args.messageText,
      conversationId: args.conversationId,
      authorName: args.authorName,
      timestamp: args.timestamp,
    });

    // Update plot with new stacks
    await ctx.db.patch(plot._id, {
      conversationStacks: stacks,
    });
  },
});

// Action wrapper to call the mutation
export const pushToConversationStack = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
    messageId: v.id('messages'),
    messageText: v.string(),
    conversationId: v.string(),
    authorName: v.string(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    // Push message to stack
    await ctx.runMutation(internal.worldStory.pushToConversationStackMutation, {
      worldId: args.worldId,
      playerId: args.playerId,
      messageId: args.messageId,
      messageText: args.messageText,
      conversationId: args.conversationId,
      authorName: args.authorName,
      timestamp: args.timestamp,
    });

    // Check if we should trigger story generation (event-driven)
    const triggerCheck = await ctx.runQuery(internal.worldStory.shouldTriggerStoryGeneration, {
      worldId: args.worldId,
    });

    if (triggerCheck.shouldTrigger) {
      console.log(
        `[pushToConversationStack] Triggering story generation: ${triggerCheck.unprocessedMessageCount} new messages, ${triggerCheck.meaningfulConversationCount} meaningful conversations`,
      );
      // Schedule story generation (with small delay to batch multiple messages)
      await ctx.scheduler.runAfter(2000, internal.worldStory.generateNarrative, {
        worldId: args.worldId,
      });
    }
  },
});

// Internal query to get data for narrative generation
export const getNarrativeData = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (!plot) {
      return null;
    }

    // Get conversation stacks instead of time-based filtering
    const stacks: Record<string, any[]> = plot.conversationStacks || {};
    const processedIds = new Set(plot.processedMessageIds || []);
    
    // Collect all UNPROCESSED messages from all stacks
    const allStackMessages: any[] = [];
    for (const [playerId, messages] of Object.entries(stacks)) {
      for (const msg of messages) {
        const msgIdStr = typeof msg.messageId === 'string' ? msg.messageId : msg.messageId.toString();
        if (!processedIds.has(msgIdStr)) {
          allStackMessages.push(msg);
        }
      }
    }

    if (allStackMessages.length === 0) {
      return null;
    }

    // Group messages by conversation and create summaries
    const conversationGroups = new Map<string, any[]>();
    for (const msg of allStackMessages) {
      const convId = msg.conversationId?.toString() || 'unknown';
      if (!conversationGroups.has(convId)) {
        conversationGroups.set(convId, []);
      }
      conversationGroups.get(convId)!.push(msg);
    }

    // Create conversation summaries (one-line per conversation)
    const conversationSummaries = Array.from(conversationGroups.values()).map((msgs: any[]) => {
      const participants = [...new Set(msgs.map((m: any) => m.authorName))].join(' & ');
      const keyPoints = msgs.slice(-3).map((m: any) => m.text).join('; ');
      return `${participants}: ${keyPoints}`;
    });

    // Convert stack messages to messagesWithAuthors format
    const messagesWithAuthors = allStackMessages.map((msg: any) => ({
      id: msg.messageId,
      authorName: msg.authorName,
      text: msg.text,
      timestamp: msg.timestamp,
      conversationId: msg.conversationId,
    }));

    const recentStories = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(3);
    
    // Get total passage count (current number of story entries)
    const allStories = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    const passageCount = allStories.length;
    
    return {
      plot,
      messagesWithAuthors,
      conversationSummaries,
      recentNarratives: recentStories.reverse().map((s) => s.narrative).join(' '),
      passageCount,
    };
  },
});

// Internal mutation to save narrative
export const saveNarrative = internalMutation({
  args: {
    worldId: v.id('worlds'),
    narrative: v.string(),
    conflictType: v.string(),
    sourceMessages: v.array(v.id('messages')),
    characterNames: v.array(v.string()),
    lastProcessedTime: v.number(),
    processedMessageIds: v.array(v.string()), // Message IDs that were used for this story
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('worldStory', {
      worldId: args.worldId,
      narrative: args.narrative,
      conflictType: args.conflictType,
      sourceMessages: args.sourceMessages,
      characterNames: args.characterNames,
      timestamp: Date.now(),
    });

    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (plot) {
      // Update processed message IDs (add new ones, keep existing)
      const existingProcessedIds = new Set<string>(plot.processedMessageIds || []);
      for (const msgId of args.processedMessageIds) {
        existingProcessedIds.add(msgId);
      }
      
      // Update tracking: processed message IDs, last processed time, last generation time
      const now = Date.now();
      await ctx.db.patch(plot._id, {
        lastProcessedMessageTime: args.lastProcessedTime,
        processedMessageIds: Array.from(existingProcessedIds) as string[],
        lastStoryGenerationTime: now,
        // Clear conversation stacks after processing (they've been used)
        conversationStacks: {},
      });
      
      // Trigger plot summary generation (event-driven, after story is saved)
      await ctx.scheduler.runAfter(0, internal.worldStory.generatePlotSummary, {
        worldId: args.worldId,
      });
    }
  },
});

// Sync new messages to conversation stacks (called before generation)
export const syncMessagesToStacks = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    
    if (!plot) {
      return;
    }

    // Get all messages since last processed time
    const allMessages = await ctx.runQuery(api.worldStory.getAllMessagesSince, {
      worldId: args.worldId,
      sinceTime: plot.lastProcessedMessageTime || 0,
    });

    if (!allMessages || allMessages.length === 0) {
      return;
    }

    // Push each message to its stack
    for (const msg of allMessages) {
      await ctx.runMutation(internal.worldStory.pushToConversationStackMutation, {
        worldId: args.worldId,
        playerId: msg.author,
        messageId: msg._id,
        messageText: msg.text,
        conversationId: msg.conversationId,
        authorName: msg.authorName || 'Unknown',
        timestamp: msg._creationTime,
      });
    }
  },
});

// Query to get most recent story
export const getMostRecentStory = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const recentStories = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(1);
    return recentStories.length > 0 ? recentStories[0] : null;
  },
});

// Query to get all messages since a timestamp
export const getAllMessagesSince = query({
  args: {
    worldId: v.id('worlds'),
    sinceTime: v.number(),
  },
  handler: async (ctx, args) => {
    const allMessages = await ctx.db
      .query('messages')
      .filter((q) => q.eq(q.field('worldId'), args.worldId))
      .collect();
    
    const newMessages = allMessages.filter((m) => m._creationTime > args.sinceTime);
    
    // Get author names
    const messagesWithNames = await Promise.all(
      newMessages.map(async (m) => {
        const playerDesc = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', m.author))
          .first();
        return {
          ...m,
          authorName: playerDesc?.name || 'Unknown',
        };
      })
    );
    
    return messagesWithNames;
  },
});

// Continuous real-time narrative generation with plot context (action)
export const generateNarrative = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // First, sync any new messages to conversation stacks
    await ctx.runAction(internal.worldStory.syncMessagesToStacks, {
      worldId: args.worldId,
    });
    
    // Get narrative data (stacks will be populated by sync)
    const data: any = await ctx.runQuery(api.worldStory.getNarrativeData, {
      worldId: args.worldId,
    });
    
    if (!data) {
      return null;
    }

    const { plot, messagesWithAuthors, conversationSummaries, recentNarratives, passageCount }: any = data;
    
    // Check if we've reached the maximum number of passages
    if (passageCount >= MAX_PASSAGES) {
      console.log(`[generateNarrative] Story has reached maximum of ${MAX_PASSAGES} passages. Stopping generation.`);
      return null;
    }

    // Event-driven generation (triggered by conversation completion)
    // Calculate the next passage number (current count + 1)
    const nextPassageNumber = passageCount + 1;
    const isFinalPassage = nextPassageNumber === MAX_PASSAGES;
    
    // Determine the phase
    const phase = getPassagePhase(nextPassageNumber);
    const phaseInstructions = getPhaseInstructions(nextPassageNumber, phase, isFinalPassage);
    
    // Extract unique character names
    const characterNames: string[] = Array.from(
      new Set(messagesWithAuthors.map((m: any) => String(m.authorName || 'Unknown'))),
    );
    
    // Use conversation summaries instead of full conversations
    const conversationText = conversationSummaries.join('\n');
    
    // Get previous 1-2 paragraphs for context (what already happened)
    // recentNarratives is already a string of recent stories joined
    const previousParagraphs = recentNarratives || 'Beginning of the story...';
    
    const prompt: any = `You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction writing - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose, not promoting real-world harm.

Passage ${nextPassageNumber}/${MAX_PASSAGES}. ${phaseInstructions}

WHAT ALREADY HAPPENED:
${previousParagraphs}

CURRENT SITUATION:
Plot: ${plot.currentSummary}
New Conversations: ${conversationText}

CRITICAL REQUIREMENTS:
- Write something NEW that ADVANCES the plot meaningfully
- Do NOT repeat similar themes, locations, or situations from what already happened
- Introduce a NEW development, twist, discovery, or progression
- Each paragraph must move the story forward - avoid repetitive descriptions
- If previous paragraphs mentioned a location/artifact/conflict, advance it or introduce something NEW

Write exactly one dramatic sentence representing a NEW development:`;
    
    try {
      const { content }: any = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: isFinalPassage 
              ? 'You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose. Final passage - conclude the story in a single dramatic sentence resolving the conflict.'
              : 'You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose. CRITICAL: Write exactly one dramatic sentence that represents a NEW development. Do NOT repeat themes, locations, or situations from previous paragraphs. Each sentence must advance the plot meaningfully.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.85,
        max_tokens: 60,
      });
      
      // Detect conflict type from the narrative
      const conflictType: any = detectConflictType(content);
      
      // Extract processed message IDs (convert to strings for tracking)
      const processedMessageIds = messagesWithAuthors.map((m: any) => {
        const msgId = m.id;
        return typeof msgId === 'string' ? msgId : msgId.toString();
      });
      
      // Generate emojis for conversations and set as player activities (separate event-driven process)
      // Schedule separately - don't block story generation
      await ctx.scheduler.runAfter(0, internal.worldStory.generateConversationEmojisAction, {
        worldId: args.worldId,
        conversationSummaries,
        characterNames,
      });
      
      // Save the narrative
      await ctx.runMutation(internal.worldStory.saveNarrative, {
        worldId: args.worldId,
        narrative: content.trim(),
        conflictType: conflictType,
        sourceMessages: messagesWithAuthors.map((m: any) => m.id),
        characterNames: characterNames as string[],
        lastProcessedTime: Math.max(...messagesWithAuthors.map((m: any) => m.timestamp)),
        processedMessageIds: processedMessageIds,
      });
      
      // If this is the final passage, generate and save a final summary
      if (isFinalPassage) {
        console.log(`[generateNarrative] Passage ${MAX_PASSAGES} completed. Generating final summary...`);
        await ctx.scheduler.runAfter(0, internal.worldStory.generateFinalSummary, {
          worldId: args.worldId,
        });
      }
      
      console.log(`[generateNarrative] Generated passage ${nextPassageNumber} of ${MAX_PASSAGES} (phase: ${phase}${isFinalPassage ? ', FINAL' : ''})`);
      
      return { 
        narrative: content.trim(), 
        messageCount: messagesWithAuthors.length,
        conflictType: conflictType,
        passageNumber: nextPassageNumber,
        phase: phase,
      };
    } catch (error) {
      console.error('Failed to generate narrative:', error);
      return null;
    }
  },
});

// Internal query to get plot summary data
export const getPlotSummaryData = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (!plot) {
      return null;
    }

    // Event-driven: Always update when called (triggered after story generation)
    // Get all recent story entries (last 10-15 entries)
    const recentStories = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(15);
    
    if (recentStories.length === 0) {
      return null; // No new stories yet
    }

    return {
      plot,
      recentStories,
      storyCount: recentStories.length,
    };
  },
});

// Internal mutation to update plot summary
export const updatePlotSummary = internalMutation({
  args: {
    worldId: v.id('worlds'),
    currentSummary: v.string(),
    storyProgress: v.string(),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (plot) {
      await ctx.db.patch(plot._id, {
        currentSummary: args.currentSummary,
        lastSummaryTime: Date.now(),
        storyProgress: args.storyProgress,
      });
    }
  },
});

// Generate plot summary every 10 seconds for context (action)
export const generatePlotSummary = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const data: any = await ctx.runQuery(api.worldStory.getPlotSummaryData, {
      worldId: args.worldId,
    });
    
    if (!data) {
      return null;
    }

    const { plot, recentStories, storyCount }: any = data;

    const storyText = recentStories
      .reverse()
      .map((s: any) => s.narrative)
      .join(' ');

    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are summarizing fictional story events. IMPORTANT: You have a MAXIMUM of 100 TOKENS. Write a concise summary that reflects what is currently happening. Keep it brief - you MUST stay within 100 tokens total. Write 1-3 sentences maximum. No prefix text. Focus on the most recent developments.',
          },
          {
            role: 'user',
            content: `Plot: ${plot.initialPlot}
Recent Events: ${storyText}
Write a concise summary reflecting what's currently going on (MAXIMUM 100 TOKENS):`,
          },
        ],
        temperature: 0.7,
        max_tokens: 100,
      });

      // Clean up summary - remove any prefix text
      let cleanSummary = content.trim();
      // Remove common prefixes
      const prefixes = [
        'Here is a simple summary of the story:',
        'Here is the summary:',
        'Summary:',
        'Here\'s the summary:',
        'Simple summary:',
      ];
      for (const prefix of prefixes) {
        if (cleanSummary.toLowerCase().startsWith(prefix.toLowerCase())) {
          cleanSummary = cleanSummary.substring(prefix.length).trim();
        }
      }
      // Limit to 1 line max - take only the first line
      const lines = cleanSummary.split('\n').filter(l => l.trim().length > 0);
      cleanSummary = lines.length > 0 ? lines[0].trim() : cleanSummary.trim();

      // Determine story progress
      const storyProgress = determineStoryProgress(storyCount);

      // Update the plot summary
      await ctx.runMutation(internal.worldStory.updatePlotSummary, {
        worldId: args.worldId,
        currentSummary: cleanSummary,
        storyProgress: storyProgress,
      });

      return {
        summary: cleanSummary,
        storyProgress: storyProgress,
      };
    } catch (error) {
      console.error('Failed to generate plot summary:', error);
      return null;
    }
  },
});

// Generate final summary when story completes (passage 15)
export const generateFinalSummary = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args): Promise<string | null> => {
    // Get all story entries for this world
    const allStories: any = await ctx.runQuery(api.worldStory.getWorldStory, {
      worldId: args.worldId,
      limit: 15,
    });
    
    if (!allStories || allStories.length < 15) {
      console.log(`[generateFinalSummary] Not enough passages yet (${allStories?.length || 0}/15)`);
      return null;
    }
    
    // Get the plot
    const plot: any = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    
    if (!plot) {
      console.error('[generateFinalSummary] No plot found');
      return null;
    }
    
    // Check if we already generated a final summary
    if (plot.isComplete && plot.finalSummary) {
      console.log('[generateFinalSummary] Final summary already exists');
      return plot.finalSummary;
    }
    
    // Combine all story passages
    const fullStory = allStories.map((s: any) => s.narrative).join(' ');
    
    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are summarizing a fictional story conclusion. Write exactly 2 short lines. No prefix text, just the summary.',
          },
          {
            role: 'user',
            content: `Plot: ${plot.initialPlot}
Story: ${fullStory}
Write 2 short lines:`,
          },
        ],
        temperature: 0.8,
        max_tokens: 80,
      });
      
      // Clean up summary - remove any prefix text
      let cleanSummary = content.trim();
      // Remove common prefixes
      const prefixes = [
        'Here is a simple summary of the story:',
        'Here is the summary:',
        'Summary:',
        'Here\'s the summary:',
        'Simple summary:',
      ];
      for (const prefix of prefixes) {
        if (cleanSummary.toLowerCase().startsWith(prefix.toLowerCase())) {
          cleanSummary = cleanSummary.substring(prefix.length).trim();
        }
      }
      // Limit to 2 lines max
      const lines = cleanSummary.split('\n').filter(l => l.trim().length > 0).slice(0, 2);
      cleanSummary = lines.join('\n').trim();
      
      console.log(`[generateFinalSummary] Generated final summary: ${cleanSummary.substring(0, 100)}...`);
      
      // Update the plot with final summary and completion status
      await ctx.runMutation(internal.worldStory.updatePlotCompletion, {
        worldId: args.worldId,
        finalSummary: cleanSummary,
        isComplete: true,
      });
      
      return cleanSummary;
    } catch (error) {
      console.error('[generateFinalSummary] Failed to generate final summary:', error);
      return null;
    }
  },
});

// Internal mutation to update plot completion status
export const updatePlotCompletion = internalMutation({
  args: {
    worldId: v.id('worlds'),
    finalSummary: v.string(),
    isComplete: v.boolean(),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (plot) {
      await ctx.db.patch(plot._id, {
        finalSummary: args.finalSummary,
        isComplete: args.isComplete,
      });
      console.log(`[updatePlotCompletion] Updated plot completion status for world ${args.worldId}`);
    }
  },
});

// Helper function to determine story progress
function determineStoryProgress(entryCount: number): string {
  if (entryCount < 5) return 'beginning';
  if (entryCount < 15) return 'rising';
  if (entryCount < 30) return 'climax';
  return 'ongoing';
}

// Helper function to determine passage phase
// Each phase is approximately 30% (0.3) of total passages
function getPassagePhase(passageNumber: number): 'early' | 'mid' | 'climax' {
  const phaseSize = Math.floor(0.3 * MAX_PASSAGES);     // 30% of total passages per phase
  const earlyEnd = phaseSize;                             // Early: passages 1 to phaseSize
  const midEnd = phaseSize * 2;                           // Mid: passages phaseSize+1 to 2*phaseSize
  
  if (passageNumber <= earlyEnd) return 'early';
  if (passageNumber <= midEnd) return 'mid';
  return 'climax';                                       // Climax: remaining passages
}

// Helper function to get phase-specific instructions
// Each phase is approximately 30% (0.3) of total passages
function getPhaseInstructions(passageNumber: number, phase: 'early' | 'mid' | 'climax', isFinal: boolean): string {
  const phaseSize = Math.floor(0.3 * MAX_PASSAGES);       // 30% of total passages per phase
  const earlyEnd = phaseSize;                             // Early: passages 1 to phaseSize
  const midEnd = phaseSize * 2;                           // Mid: passages phaseSize+1 to 2*phaseSize
  
  if (isFinal) {
    return `CRITICAL: This is the FINAL PASSAGE (Passage ${MAX_PASSAGES} of ${MAX_PASSAGES}). You MUST conclude the story with a satisfying ending. Resolve the central conflict, tie up major plot threads, and bring the narrative to a definitive close. Make this conclusion dramatic, memorable, and emotionally resonant.`;
  }
  
  switch (phase) {
    case 'early':
      if (passageNumber === 1) {
        return `This is Passage 1 of ${MAX_PASSAGES} - the very beginning of the story. Establish the opening scene, introduce initial tensions, and set the stage for what's to come. Phase distribution: Early (0-${earlyEnd}), Mid (${earlyEnd + 1}-${midEnd}), Climax (${midEnd + 1}-${MAX_PASSAGES}).`;
      } else if (passageNumber === earlyEnd) {
        return `This is Passage ${earlyEnd} of ${MAX_PASSAGES} - transitioning from early setup to the middle act. Move beyond initial introductions and begin developing the core conflict. Start building toward the main story arc. Phase distribution: Early (0-${earlyEnd}), Mid (${earlyEnd + 1}-${midEnd}), Climax (${midEnd + 1}-${MAX_PASSAGES}).`;
      } else {
        return `This is Passage ${passageNumber} of ${MAX_PASSAGES} - Early Phase (Passages 1-${earlyEnd}, ${Math.floor(100 * 0.3)}% of story). Continue building the foundation, introducing characters and conflicts, and establishing the world and stakes. Phase distribution: Early (0-${earlyEnd}), Mid (${earlyEnd + 1}-${midEnd}), Climax (${midEnd + 1}-${MAX_PASSAGES}).`;
      }
    case 'mid':
      return `This is Passage ${passageNumber} of ${MAX_PASSAGES} - Middle Phase (Passages ${earlyEnd + 1}-${midEnd}, ${Math.floor(100 * 0.3)}% of story). The story is now in full motion. Develop conflicts, reveal complications, deepen character relationships, and build tension toward the climax. Phase distribution: Early (0-${earlyEnd}), Mid (${earlyEnd + 1}-${midEnd}), Climax (${midEnd + 1}-${MAX_PASSAGES}).`;
    case 'climax':
      return `This is Passage ${passageNumber} of ${MAX_PASSAGES} - Climax Phase (Passages ${midEnd + 1}-${MAX_PASSAGES}, ${Math.floor(100 * (1 - 0.6))}% of story). The story is reaching its peak. Escalate conflicts, intensify stakes, and drive toward resolution. Prepare for the final conclusion. Phase distribution: Early (0-${earlyEnd}), Mid (${earlyEnd + 1}-${midEnd}), Climax (${midEnd + 1}-${MAX_PASSAGES}).`;
  }
}

// Helper function to detect conflict type from narrative
function detectConflictType(narrative: string): string {
  const lower = narrative.toLowerCase();
  
  if (lower.includes('betray') || lower.includes('decei') || lower.includes('trick')) {
    return '⚔️ Betrayal';
  }
  if (lower.includes('attack') || lower.includes('fight') || lower.includes('battle') || lower.includes('confront')) {
    return '⚔️ Confrontation';
  }
  if (lower.includes('alliance') || lower.includes('join forces') || lower.includes('united')) {
    return '🤝 Alliance';
  }
  if (lower.includes('quest') || lower.includes('mission') || lower.includes('journey')) {
    return '🗺️ Quest';
  }
  if (lower.includes('mystery') || lower.includes('secret') || lower.includes('hidden') || lower.includes('discover')) {
    return '🔍 Mystery';
  }
  if (lower.includes('danger') || lower.includes('threat') || lower.includes('warning')) {
    return '⚠️ Danger';
  }
  if (lower.includes('challenge') || lower.includes('test') || lower.includes('prove')) {
    return '💪 Challenge';
  }
  
  return '⚔️ Conflict'; // Default
}

// Get latest story entry (for displaying current state)
export const getLatestStory = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const latest = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .first();
    
    return latest;
  },
});

