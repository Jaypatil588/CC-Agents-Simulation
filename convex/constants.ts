export const ACTION_TIMEOUT = 120_000; // more time for local dev
// export const ACTION_TIMEOUT = 60_000;// normally fine

export const IDLE_WORLD_TIMEOUT = 5 * 60 * 1000;
export const WORLD_HEARTBEAT_INTERVAL = 60 * 1000;

export const MAX_STEP = 10 * 60 * 1000;
export const TICK = 16;
export const STEP_INTERVAL = 1000;

export const PATHFINDING_TIMEOUT = 60 * 1000;
export const PATHFINDING_BACKOFF = 1000;
export const CONVERSATION_DISTANCE = 1.3;
export const MIDPOINT_THRESHOLD = 4;
export const TYPING_TIMEOUT = 15 * 1000;
export const COLLISION_THRESHOLD = 0.75;

// How many human players can be in a world at once.
export const MAX_HUMAN_PLAYERS = 8;

// Don't talk to anyone for 15s after having a conversation.
export const CONVERSATION_COOLDOWN = 15000;

// Don't do another activity for 10s after doing one.
export const ACTIVITY_COOLDOWN = 10_000;

// Don't talk to a player within 60s of talking to them.
export const PLAYER_CONVERSATION_COOLDOWN = 60000;

// Invite 80% of invites that come from other agents.
export const INVITE_ACCEPT_PROBABILITY = 0.8;

// Wait for 1m for invites to be accepted.
export const INVITE_TIMEOUT = 60000;

// Maximum number of concurrent LLM calls per world (for throttling)
export const MAX_CONCURRENT_LLM_CALLS = 5;

// Leave a conversation after participating too long.
export const MAX_CONVERSATION_DURATION = 90_000; // 90 seconds for shorter conversations

// Leave a conversation if it has more than 8 messages;
export const MAX_CONVERSATION_MESSAGES = 8;

// Wait for 1s after sending an input to the engine. We can remove this
// once we can await on an input being processed.
export const INPUT_DELAY = 1000;

// How many memories to get from the agent's memory.
// This is over-fetched by 10x so we can prioritize memories by more than relevance.
export const NUM_MEMORIES_TO_SEARCH = 3;

// Wait for at least 800ms before sending another message (reduced for faster conversations).
export const MESSAGE_COOLDOWN = 800;

// Don't run a turn of the agent more than once a second.
export const AGENT_WAKEUP_THRESHOLD = 1000;

// How old entries can be before we vacuum them (reduced from 2 weeks to 1 day to keep DB small)
export const VACUUM_MAX_AGE = 1 * 24 * 60 * 60 * 1000; // 1 day instead of 2 weeks
export const DELETE_BATCH_SIZE = 64;

export const HUMAN_IDLE_TOO_LONG = 5 * 60 * 1000;

export const ACTIVITIES = [
  { description: 'reading a book', emoji: '📖', duration: 60_000 },
  { description: 'daydreaming', emoji: '🤔', duration: 60_000 },
  { description: 'gardening', emoji: '🥕', duration: 60_000 },
];

export const ENGINE_ACTION_DURATION = 30000;

// Bound the number of pathfinding searches we do per game step.
export const MAX_PATHFINDS_PER_STEP = 16;

export const DEFAULT_NAME = 'Me';

// Priority levels: Lower = higher priority (for future use)
export const PRIORITY_PASSAGE_GENERATION = 0;
export const PRIORITY_SUMMARY_GENERATION = 1;

// Story generation constants (event-driven)
export const STORY_GENERATION_COOLDOWN = 30_000; // Minimum 30 seconds between story generations
export const MIN_MESSAGES_FOR_STORY = 3; // Minimum new messages before triggering story generation
export const MIN_MESSAGES_IN_CONVERSATION = 2; // Minimum messages in a conversation for it to be "meaningful"
