import { v } from 'convex/values';
import { Id } from '../_generated/dataModel';
import { ActionCtx, internalQuery } from '../_generated/server';
import { LLMMessage, chatCompletion } from '../util/llm';
import * as memory from './memory';
import { api, internal } from '../_generated/api';
import * as embeddingsCache from './embeddingsCache';
import { GameId, conversationId, playerId } from '../aiTown/ids';
import { NUM_MEMORIES_TO_SEARCH } from '../constants';

const selfInternal = internal.agent.conversation;

export async function startConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, agent, otherAgent, lastConversation } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const embedding = await embeddingsCache.fetch(
    ctx,
    `${player.name} is talking to ${otherPlayer.name}`,
  );

  const memories = await memory.searchMemories(
    ctx,
    player.id as GameId<'players'>,
    embedding,
    Number(process.env.NUM_MEMORIES_TO_SEARCH) || NUM_MEMORIES_TO_SEARCH,
  );

  const memoryWithOtherPlayer = memories.find(
    (m) => m.data.type === 'conversation' && m.data.playerIds.includes(otherPlayerId),
  );
  // Get story theme, context, and story draft
  const plot = await ctx.runQuery(api.worldStory.getWorldPlot, {
    worldId,
  });
  const initialTheme = plot?.initialPlot || '';
  const storyContext = plot?.currentSummary || '';
  
  // Get story draft
  const storyDraft = await ctx.runQuery(api.worldStory.getStoryDraftQuery, {
    worldId,
  });
  
  // Extract beginning of story draft (first 2-3 sentences)
  let storyDraftBeginning = '';
  if (storyDraft?.draftText) {
    const sentences = storyDraft.draftText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    storyDraftBeginning = sentences.slice(0, 3).join('. ').trim() + '.';
  }

  const prompt = [
    `You are ${player.name}, and you just started a conversation with ${otherPlayer.name}.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(...previousConversationPrompt(otherPlayer, lastConversation));
  prompt.push(...relatedMemoriesPrompt(memories));
  
  // Include story draft beginning
  if (storyDraftBeginning) {
    prompt.push(
      `\nSTORY CONTEXT (Beginning of the story):\n${storyDraftBeginning}\n\nThis is how the story begins. Your conversations should drive the plot forward based on this context.`,
    );
  }
  
  if (initialTheme) {
    prompt.push(
      `\nSTORY THEME:\n${initialTheme}\n\nThis is the central theme of the story. Your conversations should naturally relate to and build upon this theme.`,
    );
  }
  if (storyContext) {
    prompt.push(
      `\nCURRENT STORY CONTEXT:\n${storyContext}\n\nUse this context to inform your conversation naturally.`,
    );
  }
  
  // Extract motivation from agent identity if available
  const motivation = agent?.identity?.includes('motivation:') 
    ? agent.identity.split('motivation:')[1]?.trim() 
    : agent?.plan || '';
  
  if (motivation) {
    prompt.push(
      `\nYOUR MOTIVATION AS A PLOT DEVICE:\n${motivation}\n\nYou are a plot device in this story. Your conversations MUST drive the plot forward.`,
    );
  }
  
  if (memoryWithOtherPlayer) {
    prompt.push(
      `Be sure to include some detail or question about a previous conversation in your greeting.`,
    );
  }
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  prompt.push(lastPrompt);

  const { content } = await chatCompletion({
    messages: [
      {
        role: 'system',
        content: prompt.join('\n') + '\n\nCRITICAL REQUIREMENTS:\n1. You are a plot device. Your conversations MUST drive the plot forward.\n2. DO NOT make small talk. Every word you say should advance the story.\n3. Examples: ❌ Small talk: "Hey, how are you?" or "Nice weather today" ✅ Plot-driving: "I found the evidence we need" or "The plan is ready"\n4. Speak in ACTIVE VOICE - say what you are doing, thinking, or feeling directly. DO NOT describe your actions in third person.\n5. Keep your response under 15 words. Maximum one sentence.\n\nExamples:\n❌ BAD: "I am walking over to you" or "I think we should talk" or "Hey, how are you doing?"\n✅ GOOD: "I found the key" or "The meeting is at midnight" or "We need to act now"\n\nWrite exactly one short line. Speak naturally and directly.',
      },
    ],
    max_tokens: 40, // Reduced for 15-word limit
    temperature: 0.85,
    stop: stopWords(otherPlayer.name, player.name),
  });
  return trimContentPrefx(content, lastPrompt);
}

function trimContentPrefx(content: string, prompt: string) {
  if (content.startsWith(prompt)) {
    return content.slice(prompt.length).trim();
  }
  return content;
}

export async function continueConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, conversation, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  const now = Date.now();
  const started = new Date(conversation.created);
  const embedding = await embeddingsCache.fetch(
    ctx,
    `What do you think about ${otherPlayer.name}?`,
  );
  const memories = await memory.searchMemories(ctx, player.id as GameId<'players'>, embedding, 3);
  
  // Get story theme, context, and story draft
  const plot = await ctx.runQuery(api.worldStory.getWorldPlot, {
    worldId,
  });
  const initialTheme = plot?.initialPlot || '';
  const storyContext = plot?.currentSummary || '';
  
  // Get story draft
  const storyDraft = await ctx.runQuery(api.worldStory.getStoryDraftQuery, {
    worldId,
  });
  
  // Extract beginning of story draft (first 2-3 sentences)
  let storyDraftBeginning = '';
  if (storyDraft?.draftText) {
    const sentences = storyDraft.draftText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    storyDraftBeginning = sentences.slice(0, 3).join('. ').trim() + '.';
  }

  const prompt = [
    `You are ${player.name}, and you're currently in a conversation with ${otherPlayer.name}.`,
    `The conversation started at ${started.toLocaleString()}. It's now ${now.toLocaleString()}.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  prompt.push(...relatedMemoriesPrompt(memories));
  
  // Include story draft beginning
  if (storyDraftBeginning) {
    prompt.push(
      `\nSTORY CONTEXT (Beginning of the story):\n${storyDraftBeginning}\n\nThis is how the story begins. Your conversations should drive the plot forward based on this context.`,
    );
  }
  
  if (initialTheme) {
    prompt.push(
      `\nSTORY THEME:\n${initialTheme}\n\nThis is the central theme of the story. Your conversations should naturally relate to and build upon this theme.`,
    );
  }
  if (storyContext) {
    prompt.push(
      `\nCURRENT STORY CONTEXT:\n${storyContext}\n\nUse this context to inform your conversation naturally.`,
    );
  }
  
  // Extract motivation from agent identity if available
  const motivation = agent?.identity?.includes('motivation:') 
    ? agent.identity.split('motivation:')[1]?.trim() 
    : agent?.plan || '';
  
  if (motivation) {
    prompt.push(
      `\nYOUR MOTIVATION AS A PLOT DEVICE:\n${motivation}\n\nYou are a plot device in this story. Your conversations MUST drive the plot forward.`,
    );
  }
  
  prompt.push(
    `Below is the current chat history between you and ${otherPlayer.name}.`,
    `DO NOT greet them again. Do NOT use the word "Hey" too often.`,
  );

  const llmMessages: LLMMessage[] = [
    {
      role: 'system',
      content: prompt.join('\n') + '\n\nCRITICAL REQUIREMENTS:\n1. You are a plot device. Your conversations MUST drive the plot forward.\n2. DO NOT make small talk. Every word you say should advance the story.\n3. Examples: ❌ Small talk: "Hey, how are you?" or "Nice weather today" ✅ Plot-driving: "I found the evidence we need" or "The plan is ready"\n4. Speak in ACTIVE VOICE - say what you are doing, thinking, or feeling directly. DO NOT describe your actions in third person.\n5. Keep your response under 15 words. Maximum one sentence.\n\nExamples:\n❌ BAD: "I am walking over to you" or "I think we should talk" or "Hey, how are you doing?"\n✅ GOOD: "I found the key" or "The meeting is at midnight" or "We need to act now"\n\nWrite exactly one short line. Speak naturally and directly.',
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation.id as GameId<'conversations'>,
    )),
  ];
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  llmMessages.push({ role: 'user', content: lastPrompt });

  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 40, // Reduced for 15-word limit
    temperature: 0.85,
    stop: stopWords(otherPlayer.name, player.name),
  });
  return trimContentPrefx(content, lastPrompt);
}

export async function leaveConversationMessage(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  conversationId: GameId<'conversations'>,
  playerId: GameId<'players'>,
  otherPlayerId: GameId<'players'>,
): Promise<string> {
  const { player, otherPlayer, conversation, agent, otherAgent } = await ctx.runQuery(
    selfInternal.queryPromptData,
    {
      worldId,
      playerId,
      otherPlayerId,
      conversationId,
    },
  );
  // Get story theme, context, and story draft
  const plot = await ctx.runQuery(api.worldStory.getWorldPlot, {
    worldId,
  });
  const initialTheme = plot?.initialPlot || '';
  const storyContext = plot?.currentSummary || '';
  
  // Get story draft
  const storyDraft = await ctx.runQuery(api.worldStory.getStoryDraftQuery, {
    worldId,
  });
  
  // Extract beginning of story draft (first 2-3 sentences)
  let storyDraftBeginning = '';
  if (storyDraft?.draftText) {
    const sentences = storyDraft.draftText.split(/[.!?]+/).filter(s => s.trim().length > 0);
    storyDraftBeginning = sentences.slice(0, 3).join('. ').trim() + '.';
  }

  const prompt = [
    `You are ${player.name}, and you're currently in a conversation with ${otherPlayer.name}.`,
    `You've decided to leave and would like to politely tell them you're leaving the conversation.`,
  ];
  prompt.push(...agentPrompts(otherPlayer, agent, otherAgent ?? null));
  
  // Include story draft beginning
  if (storyDraftBeginning) {
    prompt.push(
      `\nSTORY CONTEXT (Beginning of the story):\n${storyDraftBeginning}\n\nThis is how the story begins. Your conversations should drive the plot forward based on this context.`,
    );
  }
  
  if (initialTheme) {
    prompt.push(
      `\nSTORY THEME:\n${initialTheme}\n\nThis is the central theme of the story. Your conversations should naturally relate to and build upon this theme.`,
    );
  }
  if (storyContext) {
    prompt.push(
      `\nCURRENT STORY CONTEXT:\n${storyContext}\n\nUse this context to inform your conversation naturally.`,
    );
  }
  
  // Extract motivation from agent identity if available
  const motivation = agent?.identity?.includes('motivation:') 
    ? agent.identity.split('motivation:')[1]?.trim() 
    : agent?.plan || '';
  
  if (motivation) {
    prompt.push(
      `\nYOUR MOTIVATION AS A PLOT DEVICE:\n${motivation}\n\nYou are a plot device in this story. Your conversations MUST drive the plot forward.`,
    );
  }
  
  prompt.push(
    `Below is the current chat history between you and ${otherPlayer.name}.`,
    `How would you like to tell them that you're leaving?`,
  );
  const llmMessages: LLMMessage[] = [
    {
      role: 'system',
      content: prompt.join('\n') + '\n\nCRITICAL REQUIREMENTS:\n1. You are a plot device. Your conversations MUST drive the plot forward.\n2. DO NOT make small talk. Even when leaving, make it plot-relevant if possible.\n3. Speak in ACTIVE VOICE - say what you are doing directly. DO NOT describe your actions in third person.\n4. Keep your response under 15 words. Maximum one sentence.\n\nExamples:\n❌ BAD: "I am leaving now" or "I need to go"\n✅ GOOD: "I gotta go, see you later" or "Talk to you soon" or "I found what we need, catch you later"\n\nWrite exactly one short line. Speak naturally and directly.',
    },
    ...(await previousMessages(
      ctx,
      worldId,
      player,
      otherPlayer,
      conversation.id as GameId<'conversations'>,
    )),
  ];
  const lastPrompt = `${player.name} to ${otherPlayer.name}:`;
  llmMessages.push({ role: 'user', content: lastPrompt });

  const { content } = await chatCompletion({
    messages: llmMessages,
    max_tokens: 40, // Reduced for 15-word limit
    temperature: 0.85,
    stop: stopWords(otherPlayer.name, player.name),
  });
  return trimContentPrefx(content, lastPrompt);
}

function agentPrompts(
  otherPlayer: { name: string },
  agent: { identity: string; plan: string } | null,
  otherAgent: { identity: string; plan: string } | null,
): string[] {
  const prompt = [];
  if (agent) {
    prompt.push(`YOUR PERSONALITY AND CONVERSATION STYLE:`);
    prompt.push(`${agent.identity}`);
    prompt.push(`Your goals for this conversation: ${agent.plan}`);
    prompt.push(`Remember to speak and act according to your personality traits.`);
  }
  if (otherAgent) {
    prompt.push(`\n${otherPlayer.name.toUpperCase()}'S PERSONALITY AND CONVERSATION STYLE:`);
    prompt.push(`${otherAgent.identity}`);
    prompt.push(`${otherPlayer.name}'s goals: ${otherAgent.plan}`);
    prompt.push(`Consider ${otherPlayer.name}'s personality and conversation style when responding - adapt your approach to match their traits.`);
  }
  return prompt;
}

function previousConversationPrompt(
  otherPlayer: { name: string },
  conversation: { created: number } | null,
): string[] {
  const prompt = [];
  if (conversation) {
    const prev = new Date(conversation.created);
    const now = new Date();
    prompt.push(
      `Last time you chatted with ${
        otherPlayer.name
      } it was ${prev.toLocaleString()}. It's now ${now.toLocaleString()}.`,
    );
  }
  return prompt;
}

function relatedMemoriesPrompt(memories: memory.Memory[]): string[] {
  const prompt = [];
  if (memories.length > 0) {
    prompt.push(`Here are some related memories in decreasing relevance order:`);
    for (const memory of memories) {
      prompt.push(' - ' + memory.description);
    }
  }
  return prompt;
}

async function previousMessages(
  ctx: ActionCtx,
  worldId: Id<'worlds'>,
  player: { id: string; name: string },
  otherPlayer: { id: string; name: string },
  conversationId: GameId<'conversations'>,
) {
  const llmMessages: LLMMessage[] = [];
  const prevMessages = await ctx.runQuery(api.messages.listMessages, { worldId, conversationId });
  for (const message of prevMessages) {
    const author = message.author === player.id ? player : otherPlayer;
    const recipient = message.author === player.id ? otherPlayer : player;
    llmMessages.push({
      role: 'user',
      content: `${author.name} to ${recipient.name}: ${message.text}`,
    });
  }
  return llmMessages;
}

export const queryPromptData = internalQuery({
  args: {
    worldId: v.id('worlds'),
    playerId,
    otherPlayerId: playerId,
    conversationId,
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      throw new Error(`World ${args.worldId} not found`);
    }
    const player = world.players.find((p) => p.id === args.playerId);
    if (!player) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const playerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.playerId))
      .first();
    if (!playerDescription) {
      throw new Error(`Player description for ${args.playerId} not found`);
    }
    const otherPlayer = world.players.find((p) => p.id === args.otherPlayerId);
    if (!otherPlayer) {
      throw new Error(`Player ${args.otherPlayerId} not found`);
    }
    const otherPlayerDescription = await ctx.db
      .query('playerDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('playerId', args.otherPlayerId))
      .first();
    if (!otherPlayerDescription) {
      throw new Error(`Player description for ${args.otherPlayerId} not found`);
    }
    const conversation = world.conversations.find((c) => c.id === args.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${args.conversationId} not found`);
    }
    const agent = world.agents.find((a) => a.playerId === args.playerId);
    if (!agent) {
      throw new Error(`Player ${args.playerId} not found`);
    }
    const agentDescription = await ctx.db
      .query('agentDescriptions')
      .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', agent.id))
      .first();
    if (!agentDescription) {
      throw new Error(`Agent description for ${agent.id} not found`);
    }
    const otherAgent = world.agents.find((a) => a.playerId === args.otherPlayerId);
    let otherAgentDescription;
    if (otherAgent) {
      otherAgentDescription = await ctx.db
        .query('agentDescriptions')
        .withIndex('worldId', (q) => q.eq('worldId', args.worldId).eq('agentId', otherAgent.id))
        .first();
      if (!otherAgentDescription) {
        throw new Error(`Agent description for ${otherAgent.id} not found`);
      }
    }
    const lastTogether = await ctx.db
      .query('participatedTogether')
      .withIndex('edge', (q) =>
        q
          .eq('worldId', args.worldId)
          .eq('player1', args.playerId)
          .eq('player2', args.otherPlayerId),
      )
      // Order by conversation end time descending.
      .order('desc')
      .first();

    let lastConversation = null;
    if (lastTogether) {
      lastConversation = await ctx.db
        .query('archivedConversations')
        .withIndex('worldId', (q) =>
          q.eq('worldId', args.worldId).eq('id', lastTogether.conversationId),
        )
        .first();
      if (!lastConversation) {
        throw new Error(`Conversation ${lastTogether.conversationId} not found`);
      }
    }
    return {
      player: { name: playerDescription.name, ...player },
      otherPlayer: { name: otherPlayerDescription.name, ...otherPlayer },
      conversation,
      agent: { identity: agentDescription.identity, plan: agentDescription.plan, ...agent },
      otherAgent: otherAgent && {
        identity: otherAgentDescription!.identity,
        plan: otherAgentDescription!.plan,
        ...otherAgent,
      },
      lastConversation,
    };
  },
});

function stopWords(otherPlayer: string, player: string) {
  // These are the words we ask the LLM to stop on. OpenAI only supports 4.
  const variants = [`${otherPlayer} to ${player}`];
  return variants.flatMap((stop) => [stop + ':', stop.toLowerCase() + ':']);
}
