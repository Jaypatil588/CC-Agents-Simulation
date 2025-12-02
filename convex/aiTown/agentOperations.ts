import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { WorldMap, serializedWorldMap } from './worldMap';
import { rememberConversation } from '../agent/memory';
import { GameId, agentId, conversationId, playerId } from './ids';
import {
  continueConversationMessage,
  leaveConversationMessage,
  startConversationMessage,
} from '../agent/conversation';
import { assertNever } from '../util/assertNever';
import { serializedAgent } from './agent';
import {
  ACTIVITIES,
  ACTIVITY_COOLDOWN,
  CONVERSATION_COOLDOWN,
  MAX_CONCURRENT_LLM_CALLS,
} from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';

// Helper function to send input with exponential backoff retry to reduce OCC errors
async function sendInputWithRetry(
  ctx: any,
  worldId: string,
  name: string,
  args: any,
  maxRetries: number = 3,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Add jitter: random delay between 100-1500ms to spread out concurrent requests
      const jitter = 100 + Math.random() * 1400;
      await sleep(jitter);
      
      await ctx.runMutation(api.aiTown.main.sendInput, {
        worldId,
        name,
        args,
      });
      return; // Success
    } catch (error: any) {
      // Check if it's an OCC error (ConvexError with specific message)
      const isOCCError = error?.message?.includes('concurrency control') || 
                        error?.message?.includes('changed while this mutation');
      
      if (!isOCCError || attempt === maxRetries - 1) {
        // Not an OCC error or last retry - throw it
        throw error;
      }
      
      // Exponential backoff: 500ms, 1000ms, 2000ms
      const backoff = 500 * Math.pow(2, attempt);
      const jitter = backoff * (0.5 + Math.random() * 0.5); // Add 50% jitter
      console.log(
        `[sendInputWithRetry] OCC error on attempt ${attempt + 1}/${maxRetries}, retrying after ${Math.round(jitter)}ms`,
      );
      await sleep(jitter);
    }
  }
}

export const agentRememberConversation = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      await rememberConversation(
        ctx,
        args.worldId,
        args.agentId as GameId<'agents'>,
        args.playerId as GameId<'players'>,
        args.conversationId as GameId<'conversations'>,
      );
    } catch (error) {
      console.error(
        `Error remembering conversation ${args.conversationId} for agent ${args.agentId}:`,
        error,
      );
      // Continue to finish the operation even if remembering failed
    }
    // Use retry helper to reduce OCC errors
    await sendInputWithRetry(
      ctx,
      args.worldId,
      'finishRememberConversation',
      {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    );
  },
});

// In-memory tracking of concurrent LLM calls per world
// Map<worldId, count>
const concurrentLLMCalls = new Map<string, number>();

// Validation query for conversation state
export const validateConversationState = internalQuery({
  args: {
    worldId: v.id('worlds'),
    conversationId: v.string(),
    playerId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
  },
  handler: async (ctx, args) => {
    const world = await ctx.db.get(args.worldId);
    if (!world) {
      return { valid: false, reason: 'World not found' };
    }

    // Find the conversation in the world (conversations are stored as an array in the world document)
    const conversation = world.conversations?.find((c: any) => c.id === args.conversationId);
    if (!conversation) {
      return { valid: false, reason: 'Conversation not found' };
    }

    // For "continue" messages, check strict turn-taking: agent must NOT be the last speaker
    if (args.type === 'continue') {
      if (conversation.lastMessage && conversation.lastMessage.author === args.playerId) {
        // This agent was the last speaker - they must wait for the other agent to respond
        return { valid: false, reason: 'Agent was the last speaker, must wait for response' };
      }
    }

    // Check if conversation is still active (has participants)
    if (!conversation.participants || conversation.participants.length !== 2) {
      return { valid: false, reason: 'Conversation has invalid number of participants' };
    }

    // Check if player is still in the conversation (participants is an array)
    const playerInConversation = conversation.participants.some(
      (p: any) => p.playerId === args.playerId,
    );
    if (!playerInConversation) {
      return { valid: false, reason: 'Player is not in the conversation' };
    }

    return { valid: true };
  },
});

export const agentGenerateMessage = internalAction({
  args: {
    worldId: v.id('worlds'),
    playerId,
    agentId,
    conversationId,
    otherPlayerId: playerId,
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    const worldIdStr = args.worldId;

    // EARLY VALIDATION: Check conversation state immediately when operation starts
    const earlyValidation = await ctx.runQuery(internal.aiTown.agentOperations.validateConversationState, {
      worldId: args.worldId,
      conversationId: args.conversationId,
      playerId: args.playerId,
      type: args.type,
    });

    if (!earlyValidation.valid) {
      console.log(
        `[agentGenerateMessage] Early validation failed for conversation ${args.conversationId}, player ${args.playerId}: ${earlyValidation.reason}`,
      );
      // Clear inProgressOperation by sending input to finish operation
      await sendInputWithRetry(
        ctx,
        args.worldId,
        'agentFinishSendingMessage',
        {
          agentId: args.agentId,
          conversationId: args.conversationId,
          timestamp: Date.now(),
          operationId: args.operationId,
          leaveConversation: false,
        },
      );
      return;
    }

    // CONCURRENCY CHECK: Check if we're at the limit for concurrent LLM calls
    const currentCount = concurrentLLMCalls.get(worldIdStr) || 0;
    if (currentCount >= MAX_CONCURRENT_LLM_CALLS) {
      console.log(
        `[agentGenerateMessage] Concurrency limit reached for world ${args.worldId} (${currentCount}/${MAX_CONCURRENT_LLM_CALLS}). Rejecting request.`,
      );
      // Clear inProgressOperation by sending input to finish operation
      await sendInputWithRetry(
        ctx,
        args.worldId,
        'agentFinishSendingMessage',
        {
          agentId: args.agentId,
          conversationId: args.conversationId,
          timestamp: Date.now(),
          operationId: args.operationId,
          leaveConversation: false,
        },
      );
      return;
    }

    // Increment concurrent call counter
    concurrentLLMCalls.set(worldIdStr, currentCount + 1);

    try {
      // LATE VALIDATION: Check conversation state again right before LLM call (freshest state)
      const lateValidation = await ctx.runQuery(internal.aiTown.agentOperations.validateConversationState, {
        worldId: args.worldId,
        conversationId: args.conversationId,
        playerId: args.playerId,
        type: args.type,
      });

      if (!lateValidation.valid) {
        console.log(
          `[agentGenerateMessage] Late validation failed for conversation ${args.conversationId}, player ${args.playerId}: ${lateValidation.reason}`,
        );
             // Clear inProgressOperation
             await sendInputWithRetry(
               ctx,
               args.worldId,
               'agentFinishSendingMessage',
               {
                 agentId: args.agentId,
                 conversationId: args.conversationId,
                 timestamp: Date.now(),
                 operationId: args.operationId,
                 leaveConversation: false,
               },
             );
        return;
      }

      // Call LLM function directly
      let completionFn;
      switch (args.type) {
        case 'start':
          completionFn = startConversationMessage;
          break;
        case 'continue':
          completionFn = continueConversationMessage;
          break;
        case 'leave':
          completionFn = leaveConversationMessage;
          break;
        default:
          assertNever(args.type);
      }

      const text = await completionFn(
        ctx,
        args.worldId,
        args.conversationId as GameId<'conversations'>,
        args.playerId as GameId<'players'>,
        args.otherPlayerId as GameId<'players'>,
      );

      // Send the message
      await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
        worldId: args.worldId,
        conversationId: args.conversationId,
        agentId: args.agentId,
        playerId: args.playerId,
        text,
        messageUuid: args.messageUuid,
        leaveConversation: args.type === 'leave',
        operationId: args.operationId,
      });
    } catch (error: any) {
      console.error(
        `[agentGenerateMessage] Error generating message for conversation ${args.conversationId}:`,
        error,
      );
      // On error, clear inProgressOperation so agent can retry
      await sendInputWithRetry(
        ctx,
        args.worldId,
        'agentFinishSendingMessage',
        {
          agentId: args.agentId,
          conversationId: args.conversationId,
          timestamp: Date.now(),
          operationId: args.operationId,
          leaveConversation: false,
        },
      );
      throw error;
    } finally {
      // Decrement concurrent call counter
      const newCount = Math.max(0, (concurrentLLMCalls.get(worldIdStr) || 1) - 1);
      if (newCount === 0) {
        concurrentLLMCalls.delete(worldIdStr);
      } else {
        concurrentLLMCalls.set(worldIdStr, newCount);
      }
    }
  },
});

export const agentDoSomething = internalAction({
  args: {
    worldId: v.id('worlds'),
    player: v.object(serializedPlayer),
    agent: v.object(serializedAgent),
    map: v.object(serializedWorldMap),
    otherFreePlayers: v.array(v.object(serializedPlayer)),
    operationId: v.string(),
  },
  handler: async (ctx, args) => {
    const { player, agent } = args;
    const map = new WorldMap(args.map);
    const now = Date.now();
    // Don't try to start a new conversation if we were just in one.
    const justLeftConversation =
      agent.lastConversation && now < agent.lastConversation + CONVERSATION_COOLDOWN;
    // Don't try again if we recently tried to find someone to invite.
    const recentlyAttemptedInvite =
      agent.lastInviteAttempt && now < agent.lastInviteAttempt + CONVERSATION_COOLDOWN;
    const recentActivity = player.activity && now < player.activity.until + ACTIVITY_COOLDOWN;
    // Decide whether to do an activity or wander somewhere.
    if (!player.pathfinding) {
      if (recentActivity || justLeftConversation) {
        await sendInputWithRetry(
          ctx,
          args.worldId,
          'finishDoSomething',
          {
            operationId: args.operationId,
            agentId: agent.id,
            destination: wanderDestination(map),
          },
        );
        return;
      } else {
        // TODO: have LLM choose the activity & emoji
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sendInputWithRetry(
          ctx,
          args.worldId,
          'finishDoSomething',
          {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        );
        return;
      }
    }
    // Check if theme AND story draft exist before allowing conversations
    const worldPlot = await ctx.runQuery(api.worldStory.getWorldPlot, {
      worldId: args.worldId,
    });
    const storyDraft = await ctx.runQuery(api.worldStory.getStoryDraftQuery, {
      worldId: args.worldId,
    });
    
    const hasTheme = worldPlot && worldPlot.initialPlot && worldPlot.initialPlot.trim().length > 0;
    const hasDraft = storyDraft && storyDraft.draftText && storyDraft.draftText.trim().length > 0;
    
    const invitee =
      justLeftConversation || recentlyAttemptedInvite || !hasTheme || !hasDraft
        ? undefined
        : await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });
    
    if (!hasTheme || !hasDraft) {
      // If no theme or draft, agents should just wander or do activities
      if (!player.pathfinding) {
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sendInputWithRetry(
          ctx,
          args.worldId,
          'finishDoSomething',
          {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        );
        return;
      }
    }

    // Use retry helper to reduce OCC errors
    await sendInputWithRetry(
      ctx,
      args.worldId,
      'finishDoSomething',
      {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    );
  },
});

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

// Migration function: Process all existing queue items before switching to event-driven mode
// This is a one-time migration function that should be called manually after deployment
export const migrateExistingQueueItems = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Get all queued conversations for this world
    const queue = await ctx.runQuery(internal.aiTown.agentOperations.getQueuedConversations, {
      worldId: args.worldId,
      limit: 1000, // Process up to 1000 items
    });

    if (queue.length === 0) {
      console.log(`[migrateExistingQueueItems] No queue items found for world ${args.worldId}`);
      return { processed: 0, skipped: 0 };
    }

    console.log(`[migrateExistingQueueItems] Processing ${queue.length} existing queue items for world ${args.worldId}`);

    let processedCount = 0;
    let skippedCount = 0;

    // Process each queue item
    for (const item of queue) {
      try {
        // Validate that this queue item is still valid using new validation
        const validation = await ctx.runQuery(internal.aiTown.agentOperations.validateConversationState, {
          worldId: item.worldId,
          conversationId: item.conversationId,
          playerId: item.playerId,
          type: item.type,
        });

        if (!validation.valid) {
          console.log(
            `[migrateExistingQueueItems] Skipping invalid queue item ${item._id} for conversation ${item.conversationId}: ${validation.reason}`,
          );
          skippedCount++;
          // Remove invalid item from queue
          await ctx.runMutation(internal.aiTown.agentOperations.removeQueuedConversation, {
            queueId: item._id,
          });
          continue;
        }

        // Process the conversation message using the new event-driven approach
        await ctx.scheduler.runAfter(0, internal.aiTown.agentOperations.agentGenerateMessage, {
          worldId: item.worldId,
          playerId: item.playerId,
          agentId: item.agentId,
          conversationId: item.conversationId,
          otherPlayerId: item.otherPlayerId,
          operationId: item.operationId,
          type: item.type,
          messageUuid: item.messageUuid,
        });

        // Remove from queue
        await ctx.runMutation(internal.aiTown.agentOperations.removeQueuedConversation, {
          queueId: item._id,
        });

        processedCount++;
      } catch (error) {
        console.error(
          `[migrateExistingQueueItems] Error processing queue item ${item._id} for conversation ${item.conversationId}:`,
          error,
        );
        // Remove from queue even on error
        await ctx.runMutation(internal.aiTown.agentOperations.removeQueuedConversation, {
          queueId: item._id,
        });
        skippedCount++;
      }
    }

    console.log(
      `[migrateExistingQueueItems] Completed migration. Processed: ${processedCount}, Skipped: ${skippedCount}`,
    );

    return { processed: processedCount, skipped: skippedCount };
  },
});

// Helper functions for migration (deprecated - only used for migrating existing queue items)
// Get queued conversations for processing (migration only)
export const getQueuedConversations = internalQuery({
  args: {
    worldId: v.id('worlds'),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const queue = await ctx.db
      .query('conversationQueue')
      .withIndex('worldId_priority', (q) => q.eq('worldId', args.worldId))
      .order('asc') // Lower priority number = higher priority
      .take(args.limit);

    return queue;
  },
});

// Remove a conversation from the queue after processing (migration only)
export const removeQueuedConversation = internalMutation({
  args: {
    queueId: v.id('conversationQueue'),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.queueId);
  },
});
