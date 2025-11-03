import { v } from 'convex/values';
import { internalAction, internalMutation, mutation, query } from './_generated/server';
import { api, internal } from './_generated/api';
import { chatCompletion } from './util/llm';

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
      .withIndex('conversationId', (q) => q.eq('worldId', args.worldId))
      .collect();
    
    console.log(`[resetWorldStory] Deleting ${messages.length} messages`);
    for (const message of messages) {
      await ctx.db.delete(message._id);
    }

    // Reinitialize the plot
    await ctx.scheduler.runAfter(0, internal.worldStory.initializeWorldPlot, {
      worldId: args.worldId,
    });

    console.log(`[resetWorldStory] Reset complete. Deleted ${storyEntries.length} stories, ${plots.length} plots, ${messages.length} messages`);
    return { 
      success: true, 
      message: `Story reset successfully. Cleared ${messages.length} conversations, ${storyEntries.length} story entries, and ${plots.length} plots.` 
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
            content: 'You are a master dungeon master creating an epic D&D campaign setting. Generate dramatic, conflict-driven plots with high stakes, mysteries, and adventure.',
          },
          {
            role: 'user',
            content: `Create an epic D&D adventure plot for a fantasy realm. This should be a dramatic, conflict-driven story with:
- A central conflict or threat
- High stakes and tension
- Mysteries to uncover
- Opportunities for adventure and heroism
- Room for character interactions to matter

The inhabitants of this realm are:
${characterList}

Write a 3-4 paragraph plot setup that establishes the world, the central conflict, and the atmosphere. Make it exciting and full of potential for adventure!`,
          },
        ],
        temperature: 0.9,
        max_tokens: 500,
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

    const allMessages = await ctx.db
      .query('messages')
      .filter((q) => q.eq(q.field('worldId'), args.worldId))
      .collect();
    
    const newMessages = allMessages.filter((m) => m._creationTime > plot.lastProcessedMessageTime);
    
    if (newMessages.length === 0) {
      return null;
    }

    const messagesWithAuthors = await Promise.all(
      newMessages.slice(-5).map(async (m) => {
        const playerDesc = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', m.author))
          .first();
        return {
          id: m._id,
          authorName: playerDesc?.name || 'Unknown',
          text: m.text,
          timestamp: m._creationTime,
        };
      })
    );

    const recentStories = await ctx.db
      .query('worldStory')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId))
      .order('desc')
      .take(3);
    
    return {
      plot,
      messagesWithAuthors,
      recentNarratives: recentStories.reverse().map((s) => s.narrative).join(' '),
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
      await ctx.db.patch(plot._id, {
        lastProcessedMessageTime: args.lastProcessedTime,
      });
    }
  },
});

// Continuous real-time narrative generation with plot context (action)
export const generateNarrative = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Get narrative data
    const data: any = await ctx.runQuery(api.worldStory.getNarrativeData, {
      worldId: args.worldId,
    });
    
    if (!data) {
      return null;
    }

    const { plot, messagesWithAuthors, recentNarratives }: any = data;
    
    // Extract unique character names
    const characterNames = [...new Set(messagesWithAuthors.map((m: any) => m.authorName))];
    
    // Generate narrative using LLM with plot context
    const conversationText = messagesWithAuthors
      .map((m: any) => `${m.authorName}: ${m.text}`)
      .join('\n');
    
    const prompt: any = `You are narrating an ongoing epic D&D adventure in real-time. 

MAIN PLOT CONTEXT:
${plot.currentSummary}

RECENT STORY:
${recentNarratives || 'The story is just beginning...'}

NEW CONVERSATION:
${conversationText}

Your task: Weave this new conversation into the ongoing narrative in ONE SHORT DRAMATIC PARAGRAPH (1-2 sentences max). Show how these character interactions advance the plot or reveal conflict. 

Requirements:
- Write ONLY 1-2 sentences
- Use present-tense, dramatic prose
- Highlight conflict or adventure
- Make it exciting and punchy

Continue the story:`;
    
    try {
      const { content }: any = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a master D&D dungeon master narrating an epic adventure in SHORT, PUNCHY paragraphs. Write 1-2 dramatic sentences maximum. Make every word count.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.85,
        max_tokens: 100,
      });
      
      // Detect conflict type from the narrative
      const conflictType: any = detectConflictType(content);
      
      // Save the narrative
      await ctx.runMutation(internal.worldStory.saveNarrative, {
        worldId: args.worldId,
        narrative: content.trim(),
        conflictType: conflictType,
        sourceMessages: messagesWithAuthors.map((m: any) => m.id),
        characterNames: characterNames as string[],
        lastProcessedTime: Math.max(...messagesWithAuthors.map((m: any) => m.timestamp)),
      });
      
      return { 
        narrative: content.trim(), 
        messageCount: messagesWithAuthors.length,
        conflictType: conflictType,
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

    // Check if we should update (every 10 seconds)
    const now = Date.now();
    if (now - plot.lastSummaryTime < 10000) {
      return null; // Too soon
    }

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
            content: 'You are a master storyteller summarizing an ongoing D&D campaign. Create ULTRA-CONCISE dramatic summaries (max 6 lines).',
          },
          {
            role: 'user',
            content: `ORIGINAL PLOT:
${plot.initialPlot}

RECENT STORY EVENTS:
${storyText}

Generate a BRIEF summary (MAX 6 LINES) that:
1. Captures the current state of the story
2. Highlights main conflicts
3. Maintains dramatic tone

IMPORTANT: Keep it under 6 lines. Be concise but dramatic.

Summary:`,
          },
        ],
        temperature: 0.7,
        max_tokens: 150,
      });

      // Determine story progress
      const storyProgress = determineStoryProgress(storyCount);

      // Update the plot summary
      await ctx.runMutation(internal.worldStory.updatePlotSummary, {
        worldId: args.worldId,
        currentSummary: content.trim(),
        storyProgress: storyProgress,
      });

      return {
        summary: content.trim(),
        storyProgress: storyProgress,
      };
    } catch (error) {
      console.error('Failed to generate plot summary:', error);
      return null;
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

