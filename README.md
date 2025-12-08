# Story-Driven Generative Agents 🎭📖

An event-driven narrative system for interactive AI simulations that transforms autonomous AI conversations into coherent, evolving stories.

## Overview

This project extends the [AI Town](https://github.com/a16z-infra/ai-town) framework with a comprehensive narrative layer, establishing a bidirectional feedback loop between character interactions and story progression. Inspired by the D&D storytelling paradigm, our system treats agent conversations as the primary driver of a dynamically evolving narrative.

### Key Features

- **Event-Driven Story Generation**: Narrative passages are generated in response to meaningful conversations, not arbitrary timers
- **Theme Mutation System**: Stories organically evolve based on emergent agent behavior
- **Dynamic Character Generation**: AI agents are created as plot devices from user-defined story themes
- **Structured Narrative Progression**: Stories progress through Beginning → Rising → Climax → Conclusion phases (12 passages max)
- **Rich Multimedia Integration**: Context-aware background music and real-time text-to-speech narration
- **Human Player Prioritization**: Immediate narrative impact when users participate in conversations

## How It Works

1. **User provides an initial story theme** (e.g., "A corporate espionage thriller in a futuristic city")
2. **System generates a story draft** and creates AI agents as plot devices (protagonist, antagonist, allies, informants)
3. **Agents converse autonomously**, with dialogues triggering story generation when thresholds are met
4. **Theme mutations** track how conversations alter the story's direction
5. **Story draft adapts** to emergent agent behavior while maintaining narrative coherence

## Tech Stack

- **Backend**: [Convex](https://convex.dev/) - Real-time database with transactions, subscriptions, and simulation engine
- **Frontend**: React + [PixiJS](https://pixijs.com/) for WebGL rendering
- **LLM**: Configurable (Ollama, OpenAI, Together.ai)
- **Text-to-Speech**: ElevenLabs API
- **Background Music**: Dynamic tracks based on story progression

## Installation

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone <repository-url>
cd CC-Agents-Simulation
npm install
```

### Running the Application

```bash
npm run dev
```

Visit http://localhost:5173 to access the application.

### Connect an LLM

The system defaults to Ollama for local inference:

1. Download and install [Ollama](https://ollama.com/)
2. Run `ollama serve` in a terminal
3. Pull the model: `ollama pull dolphin-llama3:8b`

For cloud LLMs (OpenAI, Together.ai), set the appropriate environment variables:

```bash
npx convex env set OPENAI_API_KEY 'your-key'
# or
npx convex env set TOGETHER_API_KEY 'your-key'
```

## Project Structure

```
├── convex/
│   ├── worldStory.ts       # Event-driven story generation (~1,900 lines)
│   ├── characterGeneration.ts  # Dynamic agent creation from themes
│   ├── agent/              # Agent memory and conversation logic
│   └── aiTown/             # Core simulation game logic
├── src/
│   ├── components/
│   │   ├── WorldStory.tsx  # Split-view narrative interface
│   │   └── buttons/MusicButton.tsx  # Dynamic music system
│   └── ...
└── assets/music/           # Stage-specific background tracks
```

## Architecture Highlights

### Event-Driven Story Generation
- Conversation stacks accumulate messages per agent
- AI conversations require 3+ messages; human players trigger immediately
- 30-second cooldown for AI (bypassed for humans)

### Theme Mutation Tracking
- `extractThemeMutation` analyzes thematic drift from conversations
- `alterStoryDraft` rewrites middle/ending sections based on emergent behavior
- Evolved theme stored in `worldPlot.evolvedTheme`

### Client-Side Features
- **Split-view layout**: 50/50 between plot summary and live story feed
- **Conflict badges**: Visual indicators for Confrontation, Alliance, Betrayal, Quest
- **Auto-scrolling narrative**: Always shows latest story passages
- **Dynamic music**: Tracks change based on story phase
- **TTS narration**: Audio queue management for seamless playback

## Authors

- **Jay Patil** - Santa Clara University (jpatil@scu.edu)
- **Manish Murugan** - Santa Clara University (mmurugan@scu.edu)
- **Sriram Madduri** - Santa Clara University (smadduri@scu.edu)

## Acknowledgments

Built upon the [AI Town](https://github.com/a16z-infra/ai-town) open-source framework by a16z-infra, which was inspired by the research paper [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/pdf/2304.03442.pdf).

## License

See [LICENSE](./LICENSE) for details.
