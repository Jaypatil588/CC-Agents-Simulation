import { ObjectType, v } from 'convex/values';
import { GameId, parseGameId } from './ids';
import { conversationId, playerId } from './ids';
import { Player } from './player';
import { inputHandler } from './inputHandler';

import { TYPING_TIMEOUT, CONVERSATION_DISTANCE } from '../constants';
import { distance, normalize, vector } from '../util/geometry';
import { Point } from '../util/types';
import { Game } from './game';
import { stopPlayer, blocked, movePlayer } from './movement';
import { ConversationMembership, serializedConversationMembership } from './conversationMembership';
import { parseMap, serializeMap } from '../util/object';

export class Conversation {
  id: GameId<'conversations'>;
  creator: GameId<'players'>;
  created: number;
  isTyping?: {
    playerId: GameId<'players'>;
    messageUuid: string;
    since: number;
  };
  lastMessage?: {
    author: GameId<'players'>;
    timestamp: number;
  };
  numMessages: number;
  participants: Map<GameId<'players'>, ConversationMembership>;

  constructor(serialized: SerializedConversation) {
    const { id, creator, created, isTyping, lastMessage, numMessages, participants } = serialized;
    this.id = parseGameId('conversations', id);
    this.creator = parseGameId('players', creator);
    this.created = created;
    this.isTyping = isTyping && {
      playerId: parseGameId('players', isTyping.playerId),
      messageUuid: isTyping.messageUuid,
      since: isTyping.since,
    };
    this.lastMessage = lastMessage && {
      author: parseGameId('players', lastMessage.author),
      timestamp: lastMessage.timestamp,
    };
    this.numMessages = numMessages;
    this.participants = parseMap(participants, ConversationMembership, (m) => m.playerId);
  }

  tick(game: Game, now: number) {
    if (this.isTyping && this.isTyping.since + TYPING_TIMEOUT < now) {
      delete this.isTyping;
    }
    if (this.participants.size !== 2) {
      console.warn(`Conversation ${this.id} has ${this.participants.size} participants`);
      return;
    }
    const [playerId1, playerId2] = [...this.participants.keys()];
    const member1 = this.participants.get(playerId1)!;
    const member2 = this.participants.get(playerId2)!;

    const player1 = game.world.players.get(playerId1)!;
    const player2 = game.world.players.get(playerId2)!;

    const playerDistance = distance(player1?.position, player2?.position);

    // If the players are both in the "walkingOver" state and they're sufficiently close, transition both
    // of them to "participating" and stop their paths.
    if (member1.status.kind === 'walkingOver' && member2.status.kind === 'walkingOver') {
      if (playerDistance < CONVERSATION_DISTANCE) {
        console.log(`Starting conversation between ${player1.id} and ${player2.id}`);

        // First, stop the two players from moving.
        stopPlayer(player1);
        stopPlayer(player2);

        member1.status = { kind: 'participating', started: now };
        member2.status = { kind: 'participating', started: now };

        // Position players exactly 3 tiles apart, facing each other
        const TARGET_CONVERSATION_DISTANCE = 3;
        const neighbors = (p: Point) => [
          { x: p.x + 1, y: p.y },
          { x: p.x - 1, y: p.y },
          { x: p.x, y: p.y + 1 },
          { x: p.x, y: p.y - 1 },
          // Add 2-tile distance options
          { x: p.x + 2, y: p.y },
          { x: p.x - 2, y: p.y },
          { x: p.x, y: p.y + 2 },
          { x: p.x, y: p.y - 2 },
          // Add 3-tile distance options
          { x: p.x + 3, y: p.y },
          { x: p.x - 3, y: p.y },
          { x: p.x, y: p.y + 3 },
          { x: p.x, y: p.y - 3 },
        ];
        const floorPos1 = { x: Math.floor(player1.position.x), y: Math.floor(player1.position.y) };
        const p1Candidates = neighbors(floorPos1).filter((p) => !blocked(game, now, p, player1.id));
        // Prefer positions that are exactly 3 tiles from player2
        p1Candidates.sort((a, b) => {
          const distA = distance(a, player2.position);
          const distB = distance(b, player2.position);
          // Prefer exactly 3 tiles
          const scoreA = Math.abs(distA - TARGET_CONVERSATION_DISTANCE);
          const scoreB = Math.abs(distB - TARGET_CONVERSATION_DISTANCE);
          return scoreA - scoreB;
        });
        if (p1Candidates.length > 0) {
          const p1Candidate = p1Candidates[0];

          // Try to move the second player to a position exactly 3 tiles from the first player's destination
          const p2Candidates = neighbors(p1Candidate).filter(
            (p) => !blocked(game, now, p, player2.id),
          );
          // Prefer positions that are exactly 3 tiles from p1Candidate
          p2Candidates.sort((a, b) => {
            const distA = distance(a, p1Candidate);
            const distB = distance(b, p1Candidate);
            const scoreA = Math.abs(distA - TARGET_CONVERSATION_DISTANCE);
            const scoreB = Math.abs(distB - TARGET_CONVERSATION_DISTANCE);
            return scoreA - scoreB;
          });
          if (p2Candidates.length > 0) {
            const p2Candidate = p2Candidates[0];
            movePlayer(game, now, player1, p1Candidate, true);
            movePlayer(game, now, player2, p2Candidate, true);
          }
        }
      }
    }

    // Orient the two players towards each other if they're participating in conversation
    // Also ensure they maintain proper distance (1-2 tiles)
    if (member1.status.kind === 'participating' && member2.status.kind === 'participating') {
      const currentDistance = distance(player1.position, player2.position);
      
      // Ensure players face each other
      const v = normalize(vector(player1.position, player2.position));
      if (v) {
        // Player 1 faces towards player 2
        if (!player1.pathfinding) {
          player1.facing = v;
        }
        // Player 2 faces towards player 1 (opposite direction)
        if (!player2.pathfinding) {
          player2.facing.dx = -v.dx;
          player2.facing.dy = -v.dy;
        }
      }
      
      // If players are too close (< 2.5 tiles) or too far (> 3.5 tiles), adjust position to exactly 3 tiles
      const TARGET_CONVERSATION_DISTANCE = 3;
      if (currentDistance < 2.5 || currentDistance > 3.5) {
        const targetDistance = TARGET_CONVERSATION_DISTANCE; // Target exactly 3 tiles
        const direction = normalize(vector(player1.position, player2.position));
        if (direction && !player1.pathfinding && !player2.pathfinding) {
          // Calculate ideal positions
          const midpoint = {
            x: (player1.position.x + player2.position.x) / 2,
            y: (player1.position.y + player2.position.y) / 2,
          };
          const idealPos1 = {
            x: Math.floor(midpoint.x - direction.dx * targetDistance / 2),
            y: Math.floor(midpoint.y - direction.dy * targetDistance / 2),
          };
          const idealPos2 = {
            x: Math.floor(midpoint.x + direction.dx * targetDistance / 2),
            y: Math.floor(midpoint.y + direction.dy * targetDistance / 2),
          };
          
          // Try to move to ideal positions if not blocked
          if (!blocked(game, now, idealPos1, player1.id)) {
            movePlayer(game, now, player1, idealPos1, true);
          }
          if (!blocked(game, now, idealPos2, player2.id)) {
            movePlayer(game, now, player2, idealPos2, true);
          }
        }
      }
    }
  }

  static start(game: Game, now: number, player: Player, invitee: Player) {
    if (player.id === invitee.id) {
      throw new Error(`Can't invite yourself to a conversation`);
    }
    // Ensure the players still exist.
    if ([...game.world.conversations.values()].find((c) => c.participants.has(player.id))) {
      const reason = `Player ${player.id} is already in a conversation`;
      console.log(reason);
      return { error: reason };
    }
    if ([...game.world.conversations.values()].find((c) => c.participants.has(invitee.id))) {
      const reason = `Player ${player.id} is already in a conversation`;
      console.log(reason);
      return { error: reason };
    }
    const conversationId = game.allocId('conversations');
    console.log(`Creating conversation ${conversationId}`);
    game.world.conversations.set(
      conversationId,
      new Conversation({
        id: conversationId,
        created: now,
        creator: player.id,
        numMessages: 0,
        participants: [
          { playerId: player.id, invited: now, status: { kind: 'walkingOver' } },
          { playerId: invitee.id, invited: now, status: { kind: 'invited' } },
        ],
      }),
    );
    return { conversationId };
  }

  setIsTyping(now: number, player: Player, messageUuid: string) {
    if (this.isTyping) {
      if (this.isTyping.playerId !== player.id) {
        throw new Error(`Player ${this.isTyping.playerId} is already typing in ${this.id}`);
      }
      return;
    }
    this.isTyping = { playerId: player.id, messageUuid, since: now };
  }

  acceptInvite(game: Game, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Player ${player.id} not in conversation ${this.id}`);
    }
    if (member.status.kind !== 'invited') {
      throw new Error(
        `Invalid membership status for ${player.id}:${this.id}: ${JSON.stringify(member)}`,
      );
    }
    member.status = { kind: 'walkingOver' };
  }

  rejectInvite(game: Game, now: number, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Player ${player.id} not in conversation ${this.id}`);
    }
    if (member.status.kind !== 'invited') {
      throw new Error(
        `Rejecting invite in wrong membership state: ${this.id}:${player.id}: ${JSON.stringify(
          member,
        )}`,
      );
    }
    this.stop(game, now);
  }

  stop(game: Game, now: number) {
    delete this.isTyping;
    for (const [playerId, member] of this.participants.entries()) {
      const agent = [...game.world.agents.values()].find((a) => a.playerId === playerId);
      if (agent) {
        agent.lastConversation = now;
        agent.toRemember = this.id;
      }
    }
    game.world.conversations.delete(this.id);
  }

  leave(game: Game, now: number, player: Player) {
    const member = this.participants.get(player.id);
    if (!member) {
      throw new Error(`Couldn't find membership for ${this.id}:${player.id}`);
    }
    this.stop(game, now);
  }

  serialize(): SerializedConversation {
    const { id, creator, created, isTyping, lastMessage, numMessages } = this;
    return {
      id,
      creator,
      created,
      isTyping,
      lastMessage,
      numMessages,
      participants: serializeMap(this.participants),
    };
  }
}

export const serializedConversation = {
  id: conversationId,
  creator: playerId,
  created: v.number(),
  isTyping: v.optional(
    v.object({
      playerId,
      messageUuid: v.string(),
      since: v.number(),
    }),
  ),
  lastMessage: v.optional(
    v.object({
      author: playerId,
      timestamp: v.number(),
    }),
  ),
  numMessages: v.number(),
  participants: v.array(v.object(serializedConversationMembership)),
};
export type SerializedConversation = ObjectType<typeof serializedConversation>;

export const conversationInputs = {
  // Start a conversation, inviting the specified player.
  // Conversations can only have two participants for now,
  // so we don't have a separate "invite" input.
  startConversation: inputHandler({
    args: {
      playerId,
      invitee: playerId,
    },
    handler: (game: Game, now: number, args): GameId<'conversations'> => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID: ${playerId}`);
      }
      const inviteeId = parseGameId('players', args.invitee);
      const invitee = game.world.players.get(inviteeId);
      if (!invitee) {
        throw new Error(`Invalid player ID: ${inviteeId}`);
      }
      console.log(`Starting ${playerId} ${inviteeId}...`);
      const { conversationId, error } = Conversation.start(game, now, player, invitee);
      if (!conversationId) {
        // TODO: pass it back to the client for them to show an error.
        throw new Error(error);
      }
      return conversationId;
    },
  }),

  startTyping: inputHandler({
    args: {
      playerId,
      conversationId,
      messageUuid: v.string(),
    },
    handler: (game: Game, now: number, args): null => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID: ${playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Invalid conversation ID: ${conversationId}`);
      }
      if (conversation.isTyping && conversation.isTyping.playerId !== playerId) {
        throw new Error(
          `Player ${conversation.isTyping.playerId} is already typing in ${conversationId}`,
        );
      }
      conversation.isTyping = { playerId, messageUuid: args.messageUuid, since: now };
      return null;
    },
  }),

  finishSendingMessage: inputHandler({
    args: {
      playerId,
      conversationId,
      timestamp: v.number(),
    },
    handler: (game: Game, now: number, args): null => {
      const playerId = parseGameId('players', args.playerId);
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Invalid conversation ID: ${conversationId}`);
      }
      if (conversation.isTyping && conversation.isTyping.playerId === playerId) {
        delete conversation.isTyping;
      }
      conversation.lastMessage = { author: playerId, timestamp: args.timestamp };
      conversation.numMessages++;
      return null;
    },
  }),

  // Accept an invite to a conversation, which puts the
  // player in the "walkingOver" state until they're close
  // enough to the other participant.
  acceptInvite: inputHandler({
    args: {
      playerId,
      conversationId,
    },
    handler: (game: Game, now: number, args): null => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Invalid conversation ID ${conversationId}`);
      }
      conversation.acceptInvite(game, player);
      return null;
    },
  }),

  // Reject the invite. Eventually we might add a message
  // that explains why!
  rejectInvite: inputHandler({
    args: {
      playerId,
      conversationId,
    },
    handler: (game: Game, now: number, args): null => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Invalid conversation ID ${conversationId}`);
      }
      conversation.rejectInvite(game, now, player);
      return null;
    },
  }),
  // Leave a conversation.
  leaveConversation: inputHandler({
    args: {
      playerId,
      conversationId,
    },
    handler: (game: Game, now: number, args): null => {
      const playerId = parseGameId('players', args.playerId);
      const player = game.world.players.get(playerId);
      if (!player) {
        throw new Error(`Invalid player ID ${playerId}`);
      }
      const conversationId = parseGameId('conversations', args.conversationId);
      const conversation = game.world.conversations.get(conversationId);
      if (!conversation) {
        throw new Error(`Invalid conversation ID ${conversationId}`);
      }
      conversation.leave(game, now, player);
      return null;
    },
  }),
};
