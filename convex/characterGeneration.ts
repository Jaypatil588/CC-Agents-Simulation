import { v } from 'convex/values';
import { internalAction, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { chatCompletion } from './util/llm';
import { TRAITS, SPECIES } from '../data/traits';

// Generate character descriptions from traits (one LLM call for all)
export const generateCharacterDescriptions = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Generate 5 characters, each with a unique species and 10 random traits
    const NUM_CHARACTERS = 5;
    const TRAITS_PER_CHARACTER = 10;
    
    // Remove duplicates and ensure unique species selection
    const uniqueSpecies = [...new Set(SPECIES)];
    if (uniqueSpecies.length < NUM_CHARACTERS) {
      throw new Error(`Not enough unique species. Need ${NUM_CHARACTERS}, have ${uniqueSpecies.length}`);
    }
    
    // Shuffle and select unique species (ensuring all are distinct)
    const shuffledSpecies = [...uniqueSpecies].sort(() => Math.random() - 0.5);
    const selectedSpecies = shuffledSpecies.slice(0, NUM_CHARACTERS);
    
    // Generate characters with traits
    const characterData = [];
    for (let i = 0; i < NUM_CHARACTERS; i++) {
      // Get 10 random traits
      const shuffledTraits = [...TRAITS].sort(() => Math.random() - 0.5);
      const selectedTraits = shuffledTraits.slice(0, TRAITS_PER_CHARACTER);
      
      characterData.push({
        species: selectedSpecies[i],
        traits: selectedTraits,
        characterIndex: i, // f1, f2, f3, f4, f5
      });
    }
    
    // Create prompt for LLM to generate all character descriptions
    const traitDescriptions = characterData.map((char, idx) => 
      `Character ${idx + 1}: ${char.species} with traits: ${char.traits.join(', ')}`
    ).join('\n');
    
    const prompt = `You are creating 5 unique D&D adventure characters. Each character has a species and 10 personality traits. Generate RICH, DESCRIPTIVE character descriptions that bring them to life.

${traitDescriptions}

For each character, write:
1. A ONE-WORD name that reflects their personality and species (e.g., "Thorn", "Zephyr", "Grimm", "Sage")
2. An identity/description (approximately 250-300 tokens, MAXIMUM 5 LINES) that MUST include:
   - Their physical appearance and species characteristics (how being this species affects them)
   - DETAILED personality description: For EACH trait, explain how it manifests in their behavior, speech patterns, and decision-making
   - Show how their traits combine to create their unique personality - don't just mention traits, describe the resulting personality
   - Their background and life story that shaped them
   - Their ambitions, goals, dreams, and what truly drives them
   - Their conversation style and how they interact with others based on their traits
   - What makes them uniquely memorable and interesting
   - DO NOT write generic phrases like "seeking their place in the world" or "unique blend of traits"
   - DO NOT just list traits like "A Tabaxi with traits: X, Y, Z"
   - Instead, write a compelling narrative showing how being [Species] with [specific trait examples] makes them [specific personality description]
   - Use exactly 5 sentences/lines maximum, each rich and descriptive
3. A plan/goal (one sentence describing their current objective or quest)

IMPORTANT: 
- Names must be exactly ONE WORD
- The identity field must be MAXIMUM 5 LINES/SENTENCES
- Each line must be substantial and descriptive - no short, generic sentences
- SPECIFICALLY describe how each key trait manifests in their personality and behavior
- Make each character's personality distinct and memorable
- Show, don't tell - describe personality through behavior and characteristics
- All species must be different (already ensured in selection)

Format as JSON array with objects: [{"name": "...", "identity": "...", "plan": "..."}, ...]`;

    try {
      const { content } = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are creating D&D adventure characters. Generate RICH, DESCRIPTIVE character descriptions (MAXIMUM 5 LINES each, approximately 250-300 tokens) that bring characters to life. For EACH trait, describe how it manifests in their personality, behavior, and conversation style. DO NOT use generic phrases. DO NOT just list traits - write compelling narratives showing how traits combine into unique personalities. Each name must be exactly ONE WORD. Make each character\'s personality distinct, memorable, and interesting. Show personality through specific behaviors, not vague descriptions. Return valid JSON only.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.9,
        max_tokens: 3000,
      });
      
      // Parse JSON response
      let descriptions: any[];
      try {
        // Extract JSON from response (might have markdown code blocks)
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          descriptions = JSON.parse(jsonMatch[0]);
        } else {
          descriptions = JSON.parse(content);
        }
      } catch (parseError) {
        console.error('[generateCharacterDescriptions] Failed to parse JSON:', parseError);
        // Fallback: generate simple descriptions with better personality
        descriptions = characterData.map((char, idx) => {
          const sampleTraits = char.traits.slice(0, 3);
          return {
            name: `${char.species}${idx + 1}`,
            identity: `A ${char.species} whose ${sampleTraits[0]} nature drives them to ${sampleTraits[1]} actions, while their ${sampleTraits[2]} tendencies shape every interaction. Born from ${char.species.toLowerCase()} heritage, they carry both the strengths and burdens of their kind, making them a complex figure in any gathering. Their past experiences have forged a personality that balances their diverse traits into a cohesive, if sometimes contradictory, whole.`,
            plan: 'Explore the adventure and discover their destiny.',
          };
        });
      }
      
      // Save character descriptions with traits and species
      for (let i = 0; i < NUM_CHARACTERS && i < descriptions.length; i++) {
        const desc = descriptions[i];
        // Ensure name is exactly one word (take first word only)
        let characterName = desc.name || `Character${i + 1}`;
        const nameWords = characterName.trim().split(/\s+/);
        characterName = nameWords[0] || characterName;
        
        await ctx.runMutation(internal.characterGeneration.saveCharacterDescription, {
          worldId: args.worldId,
          characterIndex: i,
          name: characterName,
          identity: desc.identity || `A ${characterData[i].species} adventurer.`,
          plan: desc.plan || 'Explore the adventure.',
          species: characterData[i].species,
          traits: characterData[i].traits,
        });
      }
      
      return { success: true, count: descriptions.length };
    } catch (error) {
      console.error('[generateCharacterDescriptions] Error:', error);
      // Fallback to simple descriptions with one-word names
      const fallbackNames = ['Grimm', 'Zephyr', 'Thorn', 'Sage', 'Flint'];
      for (let i = 0; i < NUM_CHARACTERS; i++) {
        const sampleTraits = characterData[i].traits.slice(0, 3);
        await ctx.runMutation(internal.characterGeneration.saveCharacterDescription, {
          worldId: args.worldId,
          characterIndex: i,
          name: fallbackNames[i] || `Hero${i + 1}`,
          identity: `A ${characterData[i].species} whose ${sampleTraits[0]} nature drives them to ${sampleTraits[1]} actions, while their ${sampleTraits[2]} tendencies shape every interaction. Born from ${characterData[i].species.toLowerCase()} heritage, they carry both the strengths and burdens of their kind, making them a complex figure in any gathering. Their past experiences have forged a personality that balances their diverse traits into a cohesive, if sometimes contradictory, whole. Driven by deep personal ambitions, their every decision reflects the intricate interplay of their nature and nurture.`,
          plan: 'Explore the adventure and discover their destiny.',
          species: characterData[i].species,
          traits: characterData[i].traits,
        });
      }
      return { success: false, error: String(error) };
    }
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

