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

    // Note: We don't need to clear completion status since we're deleting all plots
    // The new plot created by initializeWorldPlot will have isComplete/finalSummary as undefined

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
            content: 'You are a professional writer creating a dramatic thriller plot. Violence and conflict are appropriate for the genre. Create dramatic plot with conflict, stakes, mystery.',
          },
          {
            role: 'user',
            content: `Create epic D&D plot. Characters: ${characterList}. Write 3-4 paragraphs establishing world, central conflict, atmosphere.`,
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
    
    // Batch messages: only process messages that are at least 5 seconds old
    const now = Date.now();
    const batchWindow = 5000; // 5 seconds
    const newMessages = allMessages.filter((m) => {
      const age = now - m._creationTime;
      return m._creationTime > plot.lastProcessedMessageTime && age >= batchWindow;
    });
    
    if (newMessages.length === 0) {
      return null;
    }

    // Group messages by conversation and create summaries
    const messagesWithAuthors = await Promise.all(
      newMessages.map(async (m) => {
        const playerDesc = await ctx.db
          .query('playerDescriptions')
          .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', m.author))
          .first();
        return {
          id: m._id,
          authorName: playerDesc?.name || 'Unknown',
          text: m.text,
          timestamp: m._creationTime,
          conversationId: m.conversationId,
        };
      })
    );

    // Group messages by conversation and create summaries
    const conversationGroups = new Map<string, typeof messagesWithAuthors>();
    for (const msg of messagesWithAuthors) {
      const convId = msg.conversationId?.toString() || 'unknown';
      if (!conversationGroups.has(convId)) {
        conversationGroups.set(convId, []);
      }
      conversationGroups.get(convId)!.push(msg);
    }

    // Create conversation summaries (one-line per conversation)
    const conversationSummaries = Array.from(conversationGroups.values()).map((msgs) => {
      const participants = [...new Set(msgs.map((m: any) => m.authorName))].join(' & ');
      const keyPoints = msgs.slice(-3).map((m: any) => m.text).join('; ');
      return `${participants}: ${keyPoints}`;
    });

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

    const { plot, messagesWithAuthors, conversationSummaries, recentNarratives, passageCount }: any = data;
    
    // Check if we've reached the maximum number of passages (15)
    if (passageCount >= 15) {
      console.log(`[generateNarrative] Story has reached maximum of 15 passages. Stopping generation.`);
      return null;
    }
    
    // Calculate the next passage number (current count + 1)
    const nextPassageNumber = passageCount + 1;
    const isFinalPassage = nextPassageNumber === 15;
    
    // Determine the phase
    const phase = getPassagePhase(nextPassageNumber);
    const phaseInstructions = getPhaseInstructions(nextPassageNumber, phase, isFinalPassage);
    
    // Extract unique character names
    const characterNames = [...new Set(messagesWithAuthors.map((m: any) => m.authorName))];
    
    // Use conversation summaries instead of full conversations
    const conversationText = conversationSummaries.join('\n');
    
    const prompt: any = `You are a professional writer crafting a thrilling narrative story. Violence and conflict are expected and appropriate for a thriller. Write compelling fiction.

Passage ${nextPassageNumber}/15. ${phaseInstructions}

Plot: ${plot.currentSummary}
Story: ${recentNarratives || 'Beginning...'}
Conversations: ${conversationText}

Write 1-2 dramatic sentences advancing the story:`;
    
    try {
      const { content }: any = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: isFinalPassage 
              ? 'You are a professional writer crafting a thrilling narrative conclusion. Violence in thrillers is appropriate and expected. Final passage - conclude the story in 2-3 dramatic sentences resolving the conflict.'
              : 'You are a professional writer crafting a thrilling narrative story. Violence and conflict in thrillers are appropriate and expected. Write 1-2 dramatic sentences. Drive story forward.',
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
      
      // If this is the final passage, generate and save a final summary
      if (isFinalPassage) {
        console.log(`[generateNarrative] Passage 15 completed. Generating final summary...`);
        await ctx.scheduler.runAfter(0, internal.worldStory.generateFinalSummary, {
          worldId: args.worldId,
        });
      }
      
      console.log(`[generateNarrative] Generated passage ${nextPassageNumber} of 15 (phase: ${phase}${isFinalPassage ? ', FINAL' : ''})`);
      
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
            content: 'Summarize story events simply and factually. Write 3-4 lines describing what happened. No drama, just simple facts.',
          },
          {
            role: 'user',
            content: `Plot: ${plot.initialPlot}
Events: ${storyText}
Simple summary (3-4 lines):`,
          },
        ],
        temperature: 0.7,
        max_tokens: 100,
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
            content: 'Summarize the story simply and factually. Write 3 lines describing what happened. No drama, just simple events.',
          },
          {
            role: 'user',
            content: `Plot: ${plot.initialPlot}
Story: ${fullStory}
Simple 3-line summary:`,
          },
        ],
        temperature: 0.8,
        max_tokens: 100,
      });
      
      const finalSummary = content.trim();
      console.log(`[generateFinalSummary] Generated final summary: ${finalSummary.substring(0, 100)}...`);
      
      // Update the plot with final summary and completion status
      await ctx.runMutation(internal.worldStory.updatePlotCompletion, {
        worldId: args.worldId,
        finalSummary: finalSummary,
        isComplete: true,
      });
      
      return finalSummary;
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
function getPassagePhase(passageNumber: number): 'early' | 'mid' | 'climax' {
  if (passageNumber <= 5) return 'early';    // Passages 1-5 (33% of 15)
  if (passageNumber <= 10) return 'mid';      // Passages 6-10 (33% of 15)
  return 'climax';                            // Passages 11-15 (33% of 15)
}

// Helper function to get phase-specific instructions
function getPhaseInstructions(passageNumber: number, phase: 'early' | 'mid' | 'climax', isFinal: boolean): string {
  if (isFinal) {
    return `CRITICAL: This is the FINAL PASSAGE (Passage 15 of 15). You MUST conclude the story with a satisfying ending. Resolve the central conflict, tie up major plot threads, and bring the narrative to a definitive close. Make this conclusion dramatic, memorable, and emotionally resonant.`;
  }
  
  switch (phase) {
    case 'early':
      if (passageNumber === 1) {
        return `This is Passage 1 of 15 - the very beginning of the story. Establish the opening scene, introduce initial tensions, and set the stage for what's to come.`;
      } else if (passageNumber === 4) {
        return `This is Passage 4 of 15 - transitioning from early setup to the middle act. Move beyond initial introductions and begin developing the core conflict. Start building toward the main story arc.`;
      } else {
        return `This is Passage ${passageNumber} of 15 - Early Phase (Passages 1-5). Continue building the foundation, introducing characters and conflicts, and establishing the world and stakes.`;
      }
    case 'mid':
      return `This is Passage ${passageNumber} of 15 - Middle Phase (Passages 6-10). The story is now in full motion. Develop conflicts, reveal complications, deepen character relationships, and build tension toward the climax.`;
    case 'climax':
      return `This is Passage ${passageNumber} of 15 - Climax Phase (Passages 11-15). The story is reaching its peak. Escalate conflicts, intensify stakes, and drive toward resolution. Prepare for the final conclusion.`;
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

