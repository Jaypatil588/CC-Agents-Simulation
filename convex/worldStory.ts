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
      totalDialogueCount: 0,
    } as any);
    
    console.log(`[createWorldPlot] Plot inserted successfully with ID: ${plotId}`);
    return plotId;
  },
});

// Internal mutation to save story draft
export const saveStoryDraft = internalMutation({
  args: {
    worldId: v.id('worlds'),
    draftText: v.string(),
    originalTheme: v.string(),
    currentVersion: v.number(),
  },
  handler: async (ctx, args) => {
    // Check if draft already exists
    const existingDraft = await ctx.db
      .query('storyDrafts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (existingDraft) {
      // Update existing draft
      await ctx.db.patch(existingDraft._id, {
        draftText: args.draftText,
        currentVersion: args.currentVersion,
        timestamp: Date.now(),
      });
      return existingDraft._id;
    }
    
    // Create new draft
    const draftId = await ctx.db.insert('storyDrafts', {
      worldId: args.worldId,
      draftText: args.draftText,
      originalTheme: args.originalTheme,
      currentVersion: args.currentVersion,
      timestamp: Date.now(),
    });
    
    return draftId;
  },
});

// Internal query to get story draft
export const getStoryDraft = internalQuery({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query('storyDrafts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    return draft;
  },
});

// Internal action to alter story draft based on conversations
export const alterStoryDraft = internalAction({
  args: {
    worldId: v.id('worlds'),
    conversationText: v.string(), // Summary of recent conversations
    characterNames: v.array(v.string()), // Characters involved
  },
  handler: async (ctx, args): Promise<string | null> => {
    console.log(`[alterStoryDraft] Altering story draft for world ${args.worldId}`);
    
    // Get current story draft
    const currentDraft: any = await ctx.runQuery(internal.worldStory.getStoryDraft, {
      worldId: args.worldId,
    });
    
    if (!currentDraft) {
      console.log(`[alterStoryDraft] No story draft found, skipping`);
      return null;
    }
    
    try {
      const { content }: { content: string } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a professional fiction writer who rewrites stories based on how character conversations have changed the plot. You maintain the story\'s beginning but update the middle and end to reflect how conversations have altered the narrative.',
          },
          {
            role: 'user',
            content: `Original Story Draft: ${currentDraft.draftText}

Recent Conversations by ${args.characterNames.join(' and ')}:
${args.conversationText}

How have these conversations altered the story? Rewrite the story draft to reflect these changes, especially the future parts. Keep the beginning mostly the same (first 1-2 sentences), but update the middle and end based on how the plot has evolved through conversations.

The new story draft should:
- Maintain the original beginning (first 1-2 sentences)
- Update the middle and end to reflect how conversations changed the plot
- Be 200 words or less
- Be a complete story from beginning to end
- Show how the conversations influenced the narrative direction

New Story Draft (200 words max):`,
          },
        ],
        temperature: 0.8,
        max_tokens: 500,
      });
      
      const newDraftText: string = content.trim();
      console.log(`[alterStoryDraft] Generated new draft (${newDraftText.length} characters)`);
      
      // Update the draft with new version
      await ctx.runMutation(internal.worldStory.saveStoryDraft, {
        worldId: args.worldId,
        draftText: newDraftText,
        originalTheme: currentDraft.originalTheme,
        currentVersion: currentDraft.currentVersion + 1,
      });
      
      return newDraftText;
    } catch (error) {
      console.error('[alterStoryDraft] Error altering story draft:', error);
      throw error;
    }
  },
});

// Public query to get story draft
export const getStoryDraftQuery = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const draft = await ctx.db
      .query('storyDrafts')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    return draft;
  },
});

// Internal action to generate story draft from theme
export const generateStoryDraft = internalAction({
  args: {
    worldId: v.id('worlds'),
    theme: v.string(),
  },
  handler: async (ctx, args) => {
    console.log(`[generateStoryDraft] Generating story draft for world ${args.worldId}`);
    
    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a professional fiction writer. Write complete, engaging stories from beginning to end.',
          },
          {
            role: 'user',
            content: `Write a complete story from beginning to end (200 words maximum) based on this theme: ${args.theme}

The story should:
- Have a clear beginning, middle, and end
- Be engaging and dramatic
- Fit within 200 words
- Be suitable for a creative storytelling game where characters will act as plot devices

Story:`,
          },
        ],
        temperature: 0.8,
        max_tokens: 500,
      });
      
      const draftText = content.trim();
      console.log(`[generateStoryDraft] Generated draft (${draftText.length} characters)`);
      
      // Save the draft
      await ctx.runMutation(internal.worldStory.saveStoryDraft, {
        worldId: args.worldId,
        draftText: draftText,
        originalTheme: args.theme,
        currentVersion: 1,
      });
      
      return draftText;
    } catch (error) {
      console.error('[generateStoryDraft] Error generating story draft:', error);
      throw error;
    }
  },
});

// Public mutation to set initial plot/theme from user input
export const setInitialPlot = mutation({
  args: {
    worldId: v.id('worlds'),
    initialPlot: v.string(),
  },
  handler: async (ctx, args): Promise<{ success: boolean; plotId?: Id<'worldPlot'>; message?: string }> => {
    console.log(`[setInitialPlot] Setting initial plot for world ${args.worldId}`);
    
    // Check if plot already exists
    const existingPlot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (existingPlot) {
      console.log(`[setInitialPlot] Plot already exists, skipping`);
      return { success: false, message: 'Plot already exists' };
    }
    
    // Create the plot with user-provided theme
    const plotId: Id<'worldPlot'> = await ctx.runMutation(internal.worldStory.createWorldPlot, {
      worldId: args.worldId,
      initialPlot: args.initialPlot.trim(),
      currentSummary: args.initialPlot.trim(),
    });
    
    console.log(`[setInitialPlot] Plot created successfully with ID: ${plotId}`);
    
    // Trigger story draft generation
    await ctx.scheduler.runAfter(0, internal.worldStory.generateStoryDraft, {
      worldId: args.worldId,
      theme: args.initialPlot.trim(),
    });
    
    // After story draft is generated, trigger agent generation
    // We'll do this in a separate action that checks for draft existence
    await ctx.scheduler.runAfter(5, internal.characterGeneration.generateAgentsFromStory, {
      worldId: args.worldId,
    });
    
    return { success: true, plotId };
  },
});

// Legacy mutation (kept for compatibility, but no longer auto-generates)
export const initializePlot = mutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    console.log(`[initializePlot] Called for world ${args.worldId} - no longer auto-generates`);
    // Just check if plot exists, don't auto-generate
    const existingPlot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (existingPlot) {
      return { success: true, plotId: existingPlot._id };
    }
    
    return { success: false, message: 'No plot exists - user must provide initial theme' };
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

// Initialize a world plot - now waits for user input (no auto-generation)
export const initializeWorldPlot = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    console.log(`[initializeWorldPlot] Checking for existing plot for world ${args.worldId}`);
    
    // Check if plot already exists
    const existingPlot: any = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    
    if (existingPlot) {
      console.log(`[initializeWorldPlot] Plot already exists for world ${args.worldId}`);
      return existingPlot;
    }

    // No plot exists - wait for user to provide initial theme/plot via UI
    console.log(`[initializeWorldPlot] No plot exists - waiting for user to provide initial theme/plot`);
    return null;
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
    prioritizeHuman: v.optional(v.boolean()), // Flag to prioritize human player conversations
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();

    if (!plot) {
      return { shouldTrigger: false, reason: 'No plot found' };
    }

    // Get conversation stacks
    const stacks: Record<string, any[]> = plot.conversationStacks || {};
    const processedIds = new Set(plot.processedMessageIds || []);

    // Get world to check which players are human
    const world = await ctx.db.get(args.worldId);
    const humanPlayerIds = new Set<string>();
    if (world && world.players) {
      for (const player of world.players) {
        if (player.human) {
          humanPlayerIds.add(player.id);
        }
      }
    }

    // Collect all unprocessed messages, marking which are from human players
    const allUnprocessedMessages: any[] = [];
    const humanMessages: any[] = [];
    for (const [playerId, messages] of Object.entries(stacks)) {
      const isHuman = humanPlayerIds.has(playerId);
      for (const msg of messages) {
        const msgIdStr = typeof msg.messageId === 'string' ? msg.messageId : msg.messageId.toString();
        if (!processedIds.has(msgIdStr)) {
          allUnprocessedMessages.push(msg);
          if (isHuman) {
            humanMessages.push(msg);
          }
        }
      }
    }

    // For human player conversations, use lower thresholds and bypass cooldown
    const hasHumanMessages = humanMessages.length > 0;
    const isHumanPriority = args.prioritizeHuman || hasHumanMessages;

    // Check cooldown (bypass for human conversations)
    if (!isHumanPriority) {
      const now = Date.now();
      const lastGeneration = plot.lastStoryGenerationTime || 0;
      if (now - lastGeneration < STORY_GENERATION_COOLDOWN) {
        return {
          shouldTrigger: false,
          reason: `Cooldown active (${Math.round((STORY_GENERATION_COOLDOWN - (now - lastGeneration)) / 1000)}s remaining)`,
        };
      }
    }

    // Use lower threshold for human conversations
    const minMessages = isHumanPriority ? 1 : MIN_MESSAGES_FOR_STORY;
    const minMessagesPerConversation = isHumanPriority ? 1 : MIN_MESSAGES_IN_CONVERSATION;

    // Check if we have enough new messages
    const messageCount = isHumanPriority && hasHumanMessages ? humanMessages.length : allUnprocessedMessages.length;
    if (messageCount < minMessages) {
      return {
        shouldTrigger: false,
        reason: `Not enough new messages (${messageCount}/${minMessages})${isHumanPriority ? ' [human priority]' : ''}`,
      };
    }

    // Group by conversation and check for meaningful conversations
    const messagesToCheck = isHumanPriority && hasHumanMessages ? humanMessages : allUnprocessedMessages;
    const conversationGroups = new Map<string, any[]>();
    for (const msg of messagesToCheck) {
      const convId = msg.conversationId?.toString() || 'unknown';
      if (!conversationGroups.has(convId)) {
        conversationGroups.set(convId, []);
      }
      conversationGroups.get(convId)!.push(msg);
    }

    // Check if we have at least one meaningful conversation
    const meaningfulConversations = Array.from(conversationGroups.values()).filter(
      (msgs) => msgs.length >= minMessagesPerConversation,
    );

    if (meaningfulConversations.length === 0) {
      return {
        shouldTrigger: false,
        reason: `No meaningful conversations (need ${minMessagesPerConversation}+ messages per conversation)${isHumanPriority ? ' [human priority]' : ''}`,
      };
    }

    return {
      shouldTrigger: true,
      unprocessedMessageCount: allUnprocessedMessages.length,
      meaningfulConversationCount: meaningfulConversations.length,
      isHumanPriority,
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

// Helper query to check if a player is human
export const isPlayerHuman = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world || !world.players) {
      return false;
    }
    const player = world.players.find((p: any) => p.id === args.playerId);
    return !!player?.human;
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
    // Check if this is a human player
    const isHuman = await ctx.runQuery(internal.worldStory.isPlayerHuman, {
      worldId: args.worldId,
      playerId: args.playerId,
    });

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
    // Pass isHuman flag to prioritize human conversations
    const triggerCheck = await ctx.runQuery(internal.worldStory.shouldTriggerStoryGeneration, {
      worldId: args.worldId,
      prioritizeHuman: isHuman,
    });

    if (triggerCheck.shouldTrigger) {
      console.log(
        `[pushToConversationStack] ${isHuman ? '🎮 HUMAN PLAYER' : '🤖 AI'} - Triggering story generation: ${triggerCheck.unprocessedMessageCount} new messages, ${triggerCheck.meaningfulConversationCount} meaningful conversations`,
      );
      // For human players, trigger immediately (or with minimal delay)
      // For AI players, use normal delay to batch messages
      const delay = isHuman ? 500 : 2000;
      await ctx.scheduler.runAfter(delay, internal.worldStory.generateNarrative, {
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
    // Include full dialogue text so story generation can interpret active voice
    const conversationSummaries = Array.from(conversationGroups.values()).map((msgs: any[]) => {
      const participants = [...new Set(msgs.map((m: any) => m.authorName))].join(' & ');
      // Include more messages to capture full dialogue context for interpretation
      const dialogueText = msgs.map((m: any) => `${m.authorName}: "${m.text}"`).join(' ');
      return `${participants} - ${dialogueText}`;
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
    conversationIds: v.optional(v.array(v.string())), // Conversation IDs to count unique dialogues
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
      
      // Count unique dialogues (conversations) from this batch
      const uniqueConversations = new Set(args.conversationIds || []);
      const dialogueCount = uniqueConversations.size;
      const currentDialogueCount = (plot as any).totalDialogueCount || 0;
      const newDialogueCount = currentDialogueCount + dialogueCount;
      
      // Update tracking: processed message IDs, last processed time, last generation time
      const now = Date.now();
      await ctx.db.patch(plot._id, {
        lastProcessedMessageTime: args.lastProcessedTime,
        processedMessageIds: Array.from(existingProcessedIds) as string[],
        lastStoryGenerationTime: now,
        totalDialogueCount: newDialogueCount,
        // Clear conversation stacks after processing (they've been used)
        conversationStacks: {},
      } as any);
      
      // Extract theme mutation if conversation text is provided
      if (args.conversationIds && args.conversationIds.length > 0 && args.characterNames.length > 0) {
        // Get conversation text from messages (we'll pass it from generateNarrative)
        // Trigger theme mutation extraction (async, don't wait)
        const conversationText = `Conversation between ${args.characterNames.join(' and ')}: ${args.sourceMessages.length} messages`;
        ctx.scheduler.runAfter(0, internal.worldStory.extractAndSaveThemeMutation, {
          worldId: args.worldId,
          conversationText: conversationText,
          characterNames: args.characterNames,
          sourceMessageIds: args.sourceMessages,
          conversationId: args.conversationIds[0], // Use first conversation ID
        });
      }
      
      // Check if we've hit 10 dialogues threshold
      const shouldGeneratePlotSummary = newDialogueCount >= 10 && (newDialogueCount % 10 === 0 || newDialogueCount === 10);
      
      if (shouldGeneratePlotSummary) {
        console.log(`[saveNarrative] Reached ${newDialogueCount} dialogues, triggering plot summary generation with unprocessed messages`);
        // Trigger plot summary generation with unprocessed messages context
        await ctx.scheduler.runAfter(0, internal.worldStory.generatePlotSummaryWithUnprocessed, {
          worldId: args.worldId,
        });
      } else {
        // Regular plot summary update (without unprocessed messages)
        await ctx.scheduler.runAfter(0, internal.worldStory.generatePlotSummary, {
          worldId: args.worldId,
        });
      }
    }
  },
});

// Internal action to extract theme mutation from conversations
export const extractThemeMutation = internalAction({
  args: {
    worldId: v.id('worlds'),
    conversationText: v.string(),
    characterNames: v.array(v.string()),
    sourceMessageIds: v.array(v.id('messages')),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const plot: any = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    
    if (!plot) {
      return null;
    }
    
    const previousTheme = plot.evolvedTheme || plot.initialPlot;
    
    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You analyze how character conversations mutate and evolve a story theme. Given the original theme and new conversations, identify how the theme has evolved. Be specific about what changed and why.',
          },
          {
            role: 'user',
            content: `Original Theme: ${plot.initialPlot}

Previous Evolved Theme: ${previousTheme}

New Conversations by ${args.characterNames.join(' and ')}:
${args.conversationText}

Analyze how this conversation mutates the theme. Provide:
1. The new evolved theme (how the theme has changed)
2. A brief description of the mutation (what changed and why)

Format as JSON: {"newTheme": "...", "mutationDescription": "..."}`,
          },
        ],
        temperature: 0.7,
        max_tokens: 300,
      });
      
      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const mutation = JSON.parse(jsonMatch[0]);
        return mutation;
      }
    } catch (error) {
      console.error('[extractThemeMutation] Error:', error);
    }
    
    return null;
  },
});

// Internal action to extract and save theme mutation
export const extractAndSaveThemeMutation = internalAction({
  args: {
    worldId: v.id('worlds'),
    conversationText: v.string(),
    characterNames: v.array(v.string()),
    sourceMessageIds: v.array(v.id('messages')),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const mutation = await ctx.runAction(internal.worldStory.extractThemeMutation, {
      worldId: args.worldId,
      conversationText: args.conversationText,
      characterNames: args.characterNames,
      sourceMessageIds: args.sourceMessageIds,
      conversationId: args.conversationId,
    });
    
    if (!mutation) {
      return;
    }
    
    // Get current mutation count
    const existingMutations = await ctx.runQuery(api.worldStory.getThemeMutations, {
      worldId: args.worldId,
    });
    const mutationIndex = existingMutations.length;
    
    // Get previous theme
    const plot: any = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    const previousTheme = plot?.evolvedTheme || plot?.initialPlot || '';
    
    // Save mutation
    await ctx.runMutation(internal.worldStory.saveThemeMutation, {
      worldId: args.worldId,
      mutationIndex: mutationIndex,
      previousTheme: previousTheme,
      newTheme: mutation.newTheme || previousTheme,
      mutationDescription: mutation.mutationDescription || 'Theme evolved through character interactions',
      sourceConversationId: args.conversationId,
      sourceMessageIds: args.sourceMessageIds,
      characterNames: args.characterNames,
    });
    
    // Update plot with evolved theme
    if (plot) {
      await ctx.runMutation(internal.worldStory.updateEvolvedTheme, {
        worldId: args.worldId,
        evolvedTheme: mutation.newTheme || previousTheme,
      });
    }
  },
});

// Internal mutation to save theme mutation
export const saveThemeMutation = internalMutation({
  args: {
    worldId: v.id('worlds'),
    mutationIndex: v.number(),
    previousTheme: v.string(),
    newTheme: v.string(),
    mutationDescription: v.string(),
    sourceConversationId: v.string(),
    sourceMessageIds: v.array(v.id('messages')),
    characterNames: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('themeMutations' as any, {
      worldId: args.worldId,
      mutationIndex: args.mutationIndex,
      previousTheme: args.previousTheme,
      newTheme: args.newTheme,
      mutationDescription: args.mutationDescription,
      sourceConversationId: args.sourceConversationId,
      sourceMessageIds: args.sourceMessageIds,
      characterNames: args.characterNames,
      timestamp: Date.now(),
    });
  },
});

// Internal mutation to update evolved theme
export const updateEvolvedTheme = internalMutation({
  args: {
    worldId: v.id('worlds'),
    evolvedTheme: v.string(),
  },
  handler: async (ctx, args) => {
    const plot = await ctx.db
      .query('worldPlot')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .first();
    
    if (plot) {
      await ctx.db.patch(plot._id, {
        evolvedTheme: args.evolvedTheme,
      } as any);
    }
  },
});

// Query to get theme mutations
export const getThemeMutations = query({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const mutations = await ctx.db
      .query('themeMutations' as any)
      .withIndex('worldId' as any, (q: any) => q.eq('worldId', args.worldId))
      .collect();
    
    return (mutations as any[]).sort((a: any, b: any) => a.mutationIndex - b.mutationIndex);
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
    
    // Get theme evolution context
    const evolvedTheme = (plot as any).evolvedTheme || plot.initialPlot;
    const themeMutations = await ctx.runQuery(api.worldStory.getThemeMutations, {
      worldId: args.worldId,
    });
    const recentMutations = themeMutations.slice(-3); // Get last 3 mutations
    const mutationContext = recentMutations.length > 0 
      ? `\nTHEME EVOLUTION:\nThe theme has evolved from "${plot.initialPlot}" to "${evolvedTheme}" through ${themeMutations.length} mutations by independent characters.\nRecent mutations:\n${recentMutations.map((m: any) => `- ${m.characterNames.join(' and ')}: ${m.mutationDescription}`).join('\n')}`
      : `\nSTORY THEME:\n${plot.initialPlot}`;

    const prompt: any = `You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction writing - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose, not promoting real-world harm.

═══════════════════════════════════════════════════════════════
LIVE ACTION UPDATE: Passage ${nextPassageNumber}/${MAX_PASSAGES}
═══════════════════════════════════════════════════════════════

${phaseInstructions}

STORY STRUCTURE:
- Total live action updates: ${MAX_PASSAGES} (this is update ${nextPassageNumber})
- Stage changes every 3 updates:
  * BEGINNING: Updates 1-3
  * RISING: Updates 4-6
  * CLIMAX: Updates 7-9
  * CONCLUSION: Updates 10-12
- After ${MAX_PASSAGES} updates, the story is concluded

WHAT ALREADY HAPPENED (CONTEXT ONLY - DO NOT REITERATE):
${previousParagraphs}

${mutationContext}

CURRENT SITUATION:
Plot Summary: ${plot.currentSummary}

CHARACTER DIALOGUES (Active Voice - interpret what they're saying):
${conversationText}

CRITICAL REQUIREMENTS - FOLLOW STRICTLY:
- The "WHAT ALREADY HAPPENED" section above is PROVIDED FOR CONTEXT ONLY - DO NOT REITERATE, SUMMARIZE, OR REPEAT any of it in your response
- Your response must contain ONLY NEW developments that have NOT been mentioned before
- INTERPRET the active voice dialogues above - these are what characters are actually saying/doing RIGHT NOW
- Characters are INDEPENDENT characters whose conversations directly shape the story theme
- The theme has evolved through their interactions - show how their dialogues continue this evolution
- Transform their dialogues into narrative prose that advances the story and reflects theme evolution
- Write something COMPLETELY NEW that ADVANCES the plot meaningfully based on what the characters are saying
- STRICTLY FORBIDDEN: Do NOT repeat, reiterate, summarize, or reference any events, themes, locations, or situations from "WHAT ALREADY HAPPENED"
- STRICTLY FORBIDDEN: Do NOT use phrases like "as mentioned before", "continuing from", "building on", or any reference to previous plot
- Introduce ONLY NEW developments, twists, discoveries, or progressions based on the CURRENT dialogues
- Each sentence must move the story forward with FRESH content - avoid any repetition whatsoever
- If previous paragraphs mentioned a location/artifact/conflict, advance it with NEW information or introduce something COMPLETELY NEW

Write exactly one dramatic sentence representing ONLY NEW developments based on interpreting the character dialogues and theme evolution. Do NOT include any reference to previous plot:`;
    
    try {
      const { content }: any = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: isFinalPassage 
              ? `You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose.\n\nCRITICAL: This is the FINAL live action update (${MAX_PASSAGES}/${MAX_PASSAGES}). The story MUST be concluded here. Conclude the story in a single dramatic sentence resolving the conflict. DO NOT reiterate previous plot - only include the conclusion. After this update, the story is complete.`
              : `You are a professional fiction writer creating narrative content for a creative storytelling game. This is creative fiction - violence and conflict in thriller/adventure stories are standard literary elements. You are writing fictional narrative prose.\n\nSTORY STRUCTURE:\n- Total live action updates: ${MAX_PASSAGES} (you are generating one of them)\n- Stages change every 3 updates: BEGINNING (1-3), RISING (4-6), CLIMAX (7-9), CONCLUSION (10-12)\n- After ${MAX_PASSAGES} updates, the story is concluded\n\nCRITICAL RULES - FOLLOW STRICTLY:\n1. The character dialogues you see are in ACTIVE VOICE (what characters are actually saying RIGHT NOW)\n2. Your job is to INTERPRET these active voice dialogues and transform them into narrative prose that advances the story\n3. Write exactly one dramatic sentence that represents ONLY NEW developments based on interpreting what the characters are saying\n4. STRICTLY FORBIDDEN: Do NOT repeat, reiterate, summarize, or reference any previous plot, themes, locations, or situations\n5. STRICTLY FORBIDDEN: Do NOT use phrases that reference previous events like "as mentioned", "continuing", "building on", etc.\n6. Your response must contain ONLY brand new developments that have never been mentioned before\n7. Each sentence must advance the plot meaningfully with completely fresh content\n8. Generate content appropriate for the current stage of the story (beginning, rising, climax, or conclusion)`,
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
      
      // Extract unique conversation IDs to count dialogues
      const conversationIds = Array.from(new Set(
        messagesWithAuthors.map((m: any) => m.conversationId?.toString() || 'unknown').filter((id: string) => id !== 'unknown')
      )) as string[];
      
      // Generate emojis for conversations and set as player activities (separate event-driven process)
      // Schedule separately - don't block story generation
      await ctx.scheduler.runAfter(0, internal.worldStory.generateConversationEmojisAction, {
        worldId: args.worldId,
        conversationSummaries,
        characterNames,
      });
      
      // Get full conversation text for theme mutation
      const fullConversationText = conversationSummaries.join('\n');
      
      // Save the narrative
      await ctx.runMutation(internal.worldStory.saveNarrative, {
        worldId: args.worldId,
        narrative: content.trim(),
        conflictType: conflictType,
        sourceMessages: messagesWithAuthors.map((m: any) => m.id),
        characterNames: characterNames as string[],
        lastProcessedTime: Math.max(...messagesWithAuthors.map((m: any) => m.timestamp)),
        processedMessageIds: processedMessageIds,
        conversationIds: conversationIds,
      });
      
      // Trigger theme mutation extraction with full conversation text
      if (conversationIds.length > 0 && characterNames.length > 0) {
        await ctx.scheduler.runAfter(0, internal.worldStory.extractAndSaveThemeMutation, {
          worldId: args.worldId,
          conversationText: fullConversationText,
          characterNames: characterNames as string[],
          sourceMessageIds: messagesWithAuthors.map((m: any) => m.id),
          conversationId: conversationIds[0],
        });
        
        // Trigger story draft alteration after meaningful conversations
        await ctx.scheduler.runAfter(2, internal.worldStory.alterStoryDraft, {
          worldId: args.worldId,
          conversationText: fullConversationText,
          characterNames: characterNames as string[],
        });
      }
      
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
            content: 'You are summarizing fictional story events. IMPORTANT: You have a MAXIMUM of 100 TOKENS. Write a concise summary that reflects ONLY what is currently happening (the most recent developments). Do NOT reiterate previous plot or old events. Keep it brief - you MUST stay within 100 tokens total. Write 1-3 sentences maximum. No prefix text. Focus STRICTLY on the most recent developments only.',
          },
          {
            role: 'user',
            content: `Plot: ${plot.initialPlot}
Recent Events: ${storyText}
Write a concise summary reflecting ONLY what's currently going on (the most recent developments). Do NOT reiterate previous plot. (MAXIMUM 100 TOKENS):`,
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

// Generate plot summary with unprocessed messages context (called every 10 dialogues)
export const generatePlotSummaryWithUnprocessed = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Get plot summary data
    const data: any = await ctx.runQuery(api.worldStory.getPlotSummaryData, {
      worldId: args.worldId,
    });
    
    if (!data) {
      return null;
    }

    const { plot, recentStories, storyCount }: any = data;

    // Get unprocessed messages from conversation stacks
    const stacks: Record<string, any[]> = plot.conversationStacks || {};
    const processedIds = new Set(plot.processedMessageIds || []);
    
    // Collect all unprocessed messages
    const unprocessedMessages: any[] = [];
    for (const [playerId, messages] of Object.entries(stacks)) {
      for (const msg of messages) {
        const msgIdStr = typeof msg.messageId === 'string' ? msg.messageId : msg.messageId.toString();
        if (!processedIds.has(msgIdStr)) {
          unprocessedMessages.push(msg);
        }
      }
    }

    // Group unprocessed messages by conversation
    const unprocessedConversations = new Map<string, any[]>();
    for (const msg of unprocessedMessages) {
      const convId = msg.conversationId?.toString() || 'unknown';
      if (!unprocessedConversations.has(convId)) {
        unprocessedConversations.set(convId, []);
      }
      unprocessedConversations.get(convId)!.push(msg);
    }

    // Create summary of unprocessed conversations
    const unprocessedSummary = Array.from(unprocessedConversations.values())
      .map((msgs: any[]) => {
        const participants = [...new Set(msgs.map((m: any) => m.authorName))].join(' & ');
        const keyPoints = msgs.slice(-3).map((m: any) => m.text).join('; ');
        return `${participants}: ${keyPoints}`;
      })
      .join('\n');

    const storyText = recentStories
      .reverse()
      .map((s: any) => s.narrative)
      .join(' ');

    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are summarizing fictional story events to guide future story generation. IMPORTANT: You have a MAXIMUM of 150 TOKENS. Write a comprehensive summary that includes both what has happened AND what is currently happening (unprocessed conversations). This summary will be used to guide the LLM for next story steps. Keep it focused and actionable. Write 2-4 sentences maximum. No prefix text.',
          },
          {
            role: 'user',
            content: `Original Plot: ${plot.initialPlot}

Story So Far:
${storyText}

Current Unprocessed Conversations (what's happening now):
${unprocessedSummary || 'No new conversations yet'}

Write a comprehensive summary that includes the story so far AND current developments to guide next story steps (MAXIMUM 150 TOKENS):`,
          },
        ],
        temperature: 0.7,
        max_tokens: 150,
      });

      // Clean up summary - remove any prefix text
      let cleanSummary = content.trim();
      const prefixes = [
        'Here is a simple summary of the story:',
        'Here is the summary:',
        'Summary:',
        'Here\'s the summary:',
        'Simple summary:',
        'Comprehensive summary:',
      ];
      for (const prefix of prefixes) {
        if (cleanSummary.toLowerCase().startsWith(prefix.toLowerCase())) {
          cleanSummary = cleanSummary.substring(prefix.length).trim();
        }
      }
      // Take first 2-3 lines max
      const lines = cleanSummary.split('\n').filter(l => l.trim().length > 0);
      cleanSummary = lines.slice(0, 3).join(' ').trim();

      // Determine story progress
      const storyProgress = determineStoryProgress(storyCount);

      // Update the plot summary
      await ctx.runMutation(internal.worldStory.updatePlotSummary, {
        worldId: args.worldId,
        currentSummary: cleanSummary,
        storyProgress: storyProgress,
      });

      console.log(`[generatePlotSummaryWithUnprocessed] Updated plot summary with ${unprocessedMessages.length} unprocessed messages from ${unprocessedConversations.size} conversations`);

      return {
        summary: cleanSummary,
        storyProgress: storyProgress,
        unprocessedMessageCount: unprocessedMessages.length,
      };
    } catch (error) {
      console.error('Failed to generate plot summary with unprocessed messages:', error);
      return null;
    }
  },
});

// Generate final summary when story completes (passage 12)
export const generateFinalSummary = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args): Promise<string | null> => {
    // Get all story entries for this world
    const allStories: any = await ctx.runQuery(api.worldStory.getWorldStory, {
      worldId: args.worldId,
      limit: MAX_PASSAGES,
    });
    
    if (!allStories || allStories.length < MAX_PASSAGES) {
      console.log(`[generateFinalSummary] Not enough passages yet (${allStories?.length || 0}/${MAX_PASSAGES})`);
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
// Stages change every 3 passages: 1-3: beginning, 4-6: rising, 7-9: climax, 10-12: conclusion
function determineStoryProgress(entryCount: number): string {
  if (entryCount <= 3) return 'beginning';
  if (entryCount <= 6) return 'rising';
  if (entryCount <= 9) return 'climax';
  if (entryCount <= 12) return 'conclusion';
  return 'conclusion'; // After 12, story is concluded
}

// Helper function to determine passage phase
// Stages change every 3 passages: 1-3: beginning, 4-6: rising, 7-9: climax, 10-12: conclusion
function getPassagePhase(passageNumber: number): 'beginning' | 'rising' | 'climax' | 'conclusion' {
  if (passageNumber <= 3) return 'beginning';
  if (passageNumber <= 6) return 'rising';
  if (passageNumber <= 9) return 'climax';
  return 'conclusion'; // Passages 10-12
}

// Helper function to get phase-specific instructions
// Stages change every 3 passages: 1-3: beginning, 4-6: rising, 7-9: climax, 10-12: conclusion
function getPhaseInstructions(passageNumber: number, phase: 'beginning' | 'rising' | 'climax' | 'conclusion', isFinal: boolean): string {
  if (isFinal) {
    return `CRITICAL: This is the FINAL PASSAGE (Passage ${passageNumber}/${MAX_PASSAGES}). The story MUST be concluded here. You MUST conclude the story with a satisfying ending. Resolve the central conflict, tie up major plot threads, and bring the narrative to a definitive close. Make this conclusion dramatic, memorable, and emotionally resonant. After this passage, the story is complete.`;
  }
  
  switch (phase) {
    case 'beginning':
      // Passages 1-3
      if (passageNumber === 1) {
        return `STAGE: BEGINNING (Passage ${passageNumber}/${MAX_PASSAGES}). This is the very beginning of the story. Establish the opening scene, introduce initial tensions, and set the stage for what's to come. You are in the BEGINNING stage (Passages 1-3 of 12). Build the foundation, introduce characters and conflicts, and establish the world and stakes.`;
      } else {
        return `STAGE: BEGINNING (Passage ${passageNumber}/${MAX_PASSAGES}). Continue building the foundation in the BEGINNING stage (Passages 1-3 of 12). Introduce characters and conflicts, establish the world and stakes, and set up the core tension.`;
      }
    case 'rising':
      // Passages 4-6
      if (passageNumber === 4) {
        return `STAGE: RISING (Passage ${passageNumber}/${MAX_PASSAGES}). Transitioning from beginning to rising action. The story is now in motion. Develop conflicts, reveal complications, deepen character relationships, and build tension. You are in the RISING stage (Passages 4-6 of 12).`;
      } else {
        return `STAGE: RISING (Passage ${passageNumber}/${MAX_PASSAGES}). Continue developing the rising action in the RISING stage (Passages 4-6 of 12). Develop conflicts, reveal complications, deepen character relationships, and build tension toward the climax.`;
      }
    case 'climax':
      // Passages 7-9
      if (passageNumber === 7) {
        return `STAGE: CLIMAX (Passage ${passageNumber}/${MAX_PASSAGES}). The story is reaching its peak. Escalate conflicts, intensify stakes, and drive toward resolution. You are in the CLIMAX stage (Passages 7-9 of 12). Prepare for the final conclusion.`;
      } else {
        return `STAGE: CLIMAX (Passage ${passageNumber}/${MAX_PASSAGES}). Continue escalating the climax in the CLIMAX stage (Passages 7-9 of 12). Escalate conflicts, intensify stakes, and drive toward resolution. Prepare for the final conclusion.`;
      }
    case 'conclusion':
      // Passages 10-11 (12 is handled by isFinal)
      if (passageNumber === 11) {
        return `STAGE: CONCLUSION (Passage ${passageNumber}/${MAX_PASSAGES}). The story is moving toward its conclusion. Resolve major conflicts, tie up plot threads, and prepare for the final resolution. You are in the CONCLUSION stage (Passages 10-12 of 12). The next passage (12/12) will be the final one.`;
      } else {
        return `STAGE: CONCLUSION (Passage ${passageNumber}/${MAX_PASSAGES}). The story is moving toward its conclusion. Resolve major conflicts, tie up plot threads, and prepare for the final resolution. You are in the CONCLUSION stage (Passages 10-12 of 12).`;
      }
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

