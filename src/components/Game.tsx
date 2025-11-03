import { useRef, useState } from 'react';
import PixiGame from './PixiGame.tsx';

import { useElementSize } from 'usehooks-ts';
import { Stage } from '@pixi/react';
import { ConvexProvider, useConvex, useQuery, useMutation } from 'convex/react';
import PlayerDetails from './PlayerDetails.tsx';
import { api } from '../../convex/_generated/api';
import { useWorldHeartbeat } from '../hooks/useWorldHeartbeat.ts';
import { useHistoricalTime } from '../hooks/useHistoricalTime.ts';
import { DebugTimeManager } from './DebugTimeManager.tsx';
import { GameId } from '../../convex/aiTown/ids.ts';
import { useServerGame } from '../hooks/serverGame.ts';
import { toast } from 'react-toastify';

export const SHOW_DEBUG_UI = !!import.meta.env.VITE_SHOW_DEBUG_UI;

export default function Game() {
  const convex = useConvex();
  const [selectedElement, setSelectedElement] = useState<{
    kind: 'player';
    id: GameId<'players'>;
  }>();
  const [gameWrapperRef, { width, height }] = useElementSize();

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;

  const game = useServerGame(worldId);
  const resetStory = useMutation(api.worldStory.resetWorldStory);

  // Send a periodic heartbeat to our world to keep it alive.
  useWorldHeartbeat();

  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime, timeManager } = useHistoricalTime(worldState?.engine);

  const scrollViewRef = useRef<HTMLDivElement>(null);

  const handleResetStory = async () => {
    if (!worldId) return;
    
    if (confirm('Reset the entire story? This will clear all conversations, narratives, and generate a fresh plot.')) {
      try {
        const result = await resetStory({ worldId });
        toast.success(result.message || 'Story and conversations reset! New plot generating...');
      } catch (error) {
        console.error('Failed to reset story:', error);
        toast.error('Failed to reset story');
      }
    }
  };

  if (!worldId || !engineId || !game) {
    return null;
  }
  return (
    <>
      {SHOW_DEBUG_UI && <DebugTimeManager timeManager={timeManager} width={200} height={100} />}
      <div className="w-full h-full flex flex-row game-frame">
        {/* Game area - 60% */}
        <div className="relative overflow-hidden bg-brown-900 w-[60%]" ref={gameWrapperRef}>
          {/* Reset Story Button - Top Right */}
          <button
            onClick={handleResetStory}
            className="absolute top-4 right-4 z-20 bg-clay-700 hover:bg-clay-600 text-clay-100 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide shadow-lg transition-all hover:scale-105 active:scale-95 border-2 border-clay-900"
            title="Reset the entire story and generate a new plot"
          >
            🔄 Reset Story
          </button>
          
          <div className="absolute inset-0">
            <div className="container">
              <Stage width={width} height={height} options={{ backgroundColor: 0x7ab5ff }}>
                {/* Re-propagate context because contexts are not shared between renderers.
https://github.com/michalochman/react-pixi-fiber/issues/145#issuecomment-531549215 */}
                <ConvexProvider client={convex}>
                  <PixiGame
                    game={game}
                    worldId={worldId}
                    engineId={engineId}
                    width={width}
                    height={height}
                    historicalTime={historicalTime}
                    setSelectedElement={setSelectedElement}
                  />
                </ConvexProvider>
              </Stage>
            </div>
          </div>
        </div>
        {/* Right column area - 40% */}
        <div
          className="flex flex-col overflow-hidden w-[40%] px-2 py-2 border-l-8 border-brown-900 bg-brown-800 text-brown-100"
          ref={scrollViewRef}
        >
          <PlayerDetails
            worldId={worldId}
            engineId={engineId}
            game={game}
            playerId={selectedElement?.id}
            setSelectedElement={setSelectedElement}
            scrollViewRef={scrollViewRef}
          />
        </div>
      </div>
    </>
  );
}
