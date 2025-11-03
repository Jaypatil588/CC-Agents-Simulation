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
  PRIORITY_CONVERSATION,
  CONVERSATION_BATCH_SIZE,
} from '../constants';
import { api, internal } from '../_generated/api';
import { sleep } from '../util/sleep';
import { serializedPlayer } from './player';

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
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishRememberConversation',
      args: {
        agentId: args.agentId,
        operationId: args.operationId,
      },
    });
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
    // Queue the conversation request instead of processing immediately
    await ctx.runMutation(internal.aiTown.agentOperations.queueConversationMessage, {
      worldId: args.worldId,
      playerId: args.playerId,
      agentId: args.agentId,
      conversationId: args.conversationId,
      otherPlayerId: args.otherPlayerId,
      operationId: args.operationId,
      type: args.type,
      messageUuid: args.messageUuid,
    });
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
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            destination: wanderDestination(map),
          },
        });
        return;
      } else {
        // TODO: have LLM choose the activity & emoji
        const activity = ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)];
        await sleep(Math.random() * 1000);
        await ctx.runMutation(api.aiTown.main.sendInput, {
          worldId: args.worldId,
          name: 'finishDoSomething',
          args: {
            operationId: args.operationId,
            agentId: agent.id,
            activity: {
              description: activity.description,
              emoji: activity.emoji,
              until: Date.now() + activity.duration,
            },
          },
        });
        return;
      }
    }
    const invitee =
      justLeftConversation || recentlyAttemptedInvite
        ? undefined
        : await ctx.runQuery(internal.aiTown.agent.findConversationCandidate, {
            now,
            worldId: args.worldId,
            player: args.player,
            otherFreePlayers: args.otherFreePlayers,
          });

    // TODO: We hit a lot of OCC errors on sending inputs in this file. It's
    // easy for them to get scheduled at the same time and line up in time.
    await sleep(Math.random() * 1000);
    await ctx.runMutation(api.aiTown.main.sendInput, {
      worldId: args.worldId,
      name: 'finishDoSomething',
      args: {
        operationId: args.operationId,
        agentId: args.agent.id,
        invitee,
      },
    });
  },
});

function wanderDestination(worldMap: WorldMap) {
  // Wander someonewhere at least one tile away from the edge.
  return {
    x: 1 + Math.floor(Math.random() * (worldMap.width - 2)),
    y: 1 + Math.floor(Math.random() * (worldMap.height - 2)),
  };
}

// Queue a conversation message for batch processing
export const queueConversationMessage = internalMutation({
  args: {
    worldId: v.id('worlds'),
    playerId: v.string(),
    agentId: v.string(),
    conversationId: v.string(),
    otherPlayerId: v.string(),
    operationId: v.string(),
    type: v.union(v.literal('start'), v.literal('continue'), v.literal('leave')),
    messageUuid: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('conversationQueue', {
      worldId: args.worldId,
      playerId: args.playerId,
      agentId: args.agentId,
      conversationId: args.conversationId,
      otherPlayerId: args.otherPlayerId,
      operationId: args.operationId,
      type: args.type,
      messageUuid: args.messageUuid,
      queuedAt: Date.now(),
      priority: PRIORITY_CONVERSATION,
    });
  },
});

// Process a batch of queued conversation messages
export const processConversationBatch = internalAction({
  args: {
    worldId: v.id('worlds'),
  },
  handler: async (ctx, args) => {
    // Get queued conversations for this world, ordered by priority and queued time
    const queue = await ctx.runQuery(internal.aiTown.agentOperations.getQueuedConversations, {
      worldId: args.worldId,
      limit: CONVERSATION_BATCH_SIZE,
    });

    if (queue.length === 0) {
      return;
    }

    console.log(`[processConversationBatch] Processing ${queue.length} conversations for world ${args.worldId}`);

    // Process conversations sequentially to reduce concurrent LLM load
    // This batches all conversations together instead of processing them immediately when requested
    for (const item of queue) {
      try {
        let completionFn;
        switch (item.type) {
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
            assertNever(item.type);
        }

        const text = await completionFn(
          ctx,
          item.worldId,
          item.conversationId as GameId<'conversations'>,
          item.playerId as GameId<'players'>,
          item.otherPlayerId as GameId<'players'>,
        );

        // Send the message
        await ctx.runMutation(internal.aiTown.agent.agentSendMessage, {
          worldId: item.worldId,
          conversationId: item.conversationId,
          agentId: item.agentId,
          playerId: item.playerId,
          text,
          messageUuid: item.messageUuid,
          leaveConversation: item.type === 'leave',
          operationId: item.operationId,
        });

        // Remove from queue
        await ctx.runMutation(internal.aiTown.agentOperations.removeQueuedConversation, {
          queueId: item._id,
        });
      } catch (error) {
        console.error(`[processConversationBatch] Error processing conversation ${item.conversationId}:`, error);
        // Remove from queue even on error to prevent infinite retries
        await ctx.runMutation(internal.aiTown.agentOperations.removeQueuedConversation, {
          queueId: item._id,
        });
      }
    }

    console.log(`[processConversationBatch] Completed processing ${queue.length} conversations`);
  },
});

// Get queued conversations for processing
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

// Remove a conversation from the queue after processing
export const removeQueuedConversation = internalMutation({
  args: {
    queueId: v.id('conversationQueue'),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.queueId);
  },
});
