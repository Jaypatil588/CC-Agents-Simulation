import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import { internal, api } from './_generated/api';
import { chatCompletion } from './util/llm';

// Generate agents from story draft using LLM
export const generateAgentsFromStory = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    console.log(`[generateAgentsFromStory] Generating agents from story draft for world ${args.worldId}`);
    
    // Get the story draft
    const storyDraft = await ctx.runQuery(api.worldStory.getStoryDraftQuery, {
      worldId: args.worldId,
    });
    
    if (!storyDraft) {
      console.log(`[generateAgentsFromStory] No story draft found, waiting...`);
      // Retry after a delay if draft doesn't exist yet
      await ctx.scheduler.runAfter(5, internal.characterGeneration.generateAgentsFromStory, {
        worldId: args.worldId,
      });
      return { success: false, message: 'Story draft not found, retrying...' };
    }
    
    console.log(`[generateAgentsFromStory] Found story draft, generating agents...`);
    
    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a creative writer who creates characters that act as plot devices in stories. Generate characters with names, personalities, and motivations that drive the plot forward.',
          },
          {
            role: 'user',
            content: `Given this complete story draft, create 3 independent characters who act as plot devices (there will also be 1 human player, making 4 total characters):

Story Draft: ${storyDraft.draftText}

For each character:
1. Name: One memorable word that fits the story
2. Personality: Brief description of their personality based on their role in the story
3. Motivation: What drives them in the story, how they act as a plot device
4. Role: Their role in the story (e.g., "protagonist", "antagonist", "ally", "informant", etc.)

Each character should be an independent plot device that can drive the story forward. They should have clear motivations that align with the story.

Format as JSON array: [{"name": "...", "personality": "...", "motivation": "...", "role": "..."}, ...]`,
          },
        ],
        temperature: 0.8,
        max_tokens: 800,
      });
      
      // Parse JSON response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('Failed to parse JSON from LLM response');
      }
      
      const agents = JSON.parse(jsonMatch[0]);
      
      if (!Array.isArray(agents) || agents.length !== 3) {
        throw new Error(`Expected 3 agents, got ${agents.length}`);
      }
      
      // Save each agent
      for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        
        // Create identity from personality and motivation
        const identity = `${agent.personality} Their motivation: ${agent.motivation}`;
        
        // Create plan based on role and motivation
        const plan = `Act as a ${agent.role} in the story. ${agent.motivation}`;
        
        // Extract some traits from personality (simplified)
        const traits = [agent.role, ...agent.personality.split(' ').slice(0, 2)].filter(Boolean);
        
        await ctx.runMutation(internal.characterGeneration.saveCharacterDescription, {
          worldId: args.worldId,
          characterIndex: i,
          name: agent.name,
          identity: identity,
          plan: plan,
          species: 'Human',
          traits: traits,
        });
      }
      
      console.log(`[generateAgentsFromStory] Successfully generated ${agents.length} agents`);
      return { success: true, count: agents.length };
    } catch (error) {
      console.error('[generateAgentsFromStory] Error generating agents:', error);
      throw error;
    }
  },
});

// Generate simple character descriptions from hardcoded traits (no LLM) - kept as fallback
export const generateCharacterDescriptions = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Generate 3 characters, each with 3-5 random traits (3 AI agents + 1 player = 4 total)
    const NUM_CHARACTERS = 3;
    const TRAITS_PER_CHARACTER = 3; // Reduced from 10 for simplicity
    
    // Shuffle names and traits
    const shuffledNames = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Casey'].sort(() => Math.random() - 0.5);
    const shuffledTraits = ['Curious', 'Adaptable', 'Independent', 'Bold', 'Cautious', 'Creative', 'Analytical', 'Intuitive', 'Strategic', 'Spontaneous', 'Loyal', 'Independent', 'Ambitious', 'Caring', 'Determined'].sort(() => Math.random() - 0.5);
    
    // Generate characters with traits
    for (let i = 0; i < NUM_CHARACTERS; i++) {
      // Get random traits for this character
      const selectedTraits = shuffledTraits.slice(i * TRAITS_PER_CHARACTER, (i + 1) * TRAITS_PER_CHARACTER);
      
      // Generate simple 1-line description based on traits
      const trait1 = selectedTraits[0] || 'Curious';
      const trait2 = selectedTraits[1] || 'Adaptable';
      const trait3 = selectedTraits[2] || 'Independent';
      
      // Create simple description
      const identity = `A ${trait1.toLowerCase()} and ${trait2.toLowerCase()} person who tends to be ${trait3.toLowerCase()} in their approach to life.`;
      
      // Simple plan/goal
      const plan = 'Engage with others and explore the world around them.';
      
      // Use shuffled name
      const characterName = shuffledNames[i] || `Character${i + 1}`;
      
      await ctx.runMutation(internal.characterGeneration.saveCharacterDescription, {
        worldId: args.worldId,
        characterIndex: i,
        name: characterName,
        identity: identity,
        plan: plan,
        species: 'Human', // Keep for compatibility but not used
        traits: selectedTraits,
      });
    }
    
    return { success: true, count: NUM_CHARACTERS };
  },
});

// Save character description to database
export const saveCharacterDescription = internalMutation({
  args: {
    worldId: v.id('worlds'),
    characterIndex: v.number(),
    name: v.string(),
    identity: v.string(),
    plan: v.string(),
    species: v.string(),
    traits: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('characterDescriptions', {
      worldId: args.worldId,
      characterIndex: args.characterIndex,
      name: args.name,
      identity: args.identity,
      plan: args.plan,
      species: args.species,
      traits: args.traits,
    });
  },
});

// Query to get generated character descriptions (public query)
export const getCharacterDescriptions = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const descriptions = await ctx.runMutation(internal.characterGeneration.queryCharacterDescriptionsQuery, {
      worldId: args.worldId,
    });
    return descriptions;
  },
});

export const queryCharacterDescriptions = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const descriptions = await ctx.runQuery(internal.characterGeneration.queryCharacterDescriptionsQuery, {
      worldId: args.worldId,
    });
    return descriptions;
  },
});

export const queryCharacterDescriptionsQuery = internalMutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('characterDescriptions')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .collect();
    return descriptions.sort((a: any, b: any) => a.characterIndex - b.characterIndex);
  },
});

// Public query for character descriptions
export const getCharacterDescriptionsQuery = internalMutation({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    const descriptions = await ctx.db
      .query('characterDescriptions')
      .withIndex('worldId', (q: any) => q.eq('worldId', args.worldId))
      .collect();
    return descriptions.sort((a: any, b: any) => a.characterIndex - b.characterIndex);
  },
});

