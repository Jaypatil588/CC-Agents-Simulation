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
  const [scrollable, setScrollable] = useState(false);
  const [gameWrapperRef, { width }] = useElementSize();

  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const engineId = worldStatus?.engineId;

  const resetStory = useMutation(api.worldStory.resetWorldStory);

  // Send a periodic heartbeat to our world to keep it alive.
  useWorldHeartbeat();

  const worldState = useQuery(api.world.worldState, worldId ? { worldId } : 'skip');
  const { historicalTime, timeManager } = useHistoricalTime(worldState?.engine);

  const scrollViewRef = useRef<HTMLDivElement>(null);
  const game = useServerGame(worldId);
  
  // Calculate game container height based on map aspect ratio to fit width
  // Add small buffer to ensure full map is visible (accounting for rounding/pixel alignment)
  const gameHeight = game && width > 0 ? (() => {
    const { width: mapWidth, height: mapHeight, tileDim } = game.worldMap;
    const worldWidth = mapWidth * tileDim;
    const worldHeight = mapHeight * tileDim;
    const mapAspectRatio = worldHeight / worldWidth;
    const calculatedHeight = width * mapAspectRatio;
    // Add 2px buffer to ensure bottom edge is visible
    return calculatedHeight + 2;
  })() : 0;

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
      <div className="w-full flex flex-row game-frame" style={{ minHeight: gameHeight > 0 ? `${gameHeight}px` : 'auto' }}>
        {/* Game area - 60% width, height based on map aspect ratio */}
        <div 
          className="relative overflow-hidden bg-brown-900 w-[60%]" 
          ref={gameWrapperRef}
          style={gameHeight > 0 ? { height: `${gameHeight}px`, minHeight: `${gameHeight}px` } : undefined}
        >
          {/* Reset Story Button - Top Right */}
          <button
            onClick={handleResetStory}
            className="absolute top-4 right-4 z-20 bg-clay-700 hover:bg-clay-600 text-clay-100 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide shadow-lg transition-all hover:scale-105 active:scale-95 border-2 border-clay-900"
            title="Reset the entire story and generate a new plot"
          >
            🔄 Reset Story
          </button>
          
          {/* Scroll Toggle Button - Top Right, below Reset Story */}
          <button
            onClick={() => setScrollable(!scrollable)}
            className="absolute top-16 right-4 z-20 bg-clay-700 hover:bg-clay-600 text-clay-100 px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wide shadow-lg transition-all hover:scale-105 active:scale-95 border-2 border-clay-900"
            title={scrollable ? "Disable map scrolling" : "Enable map scrolling"}
          >
            {scrollable ? '🔒 Lock View' : '🔓 Unlock View'}
          </button>
          
          <div className="absolute inset-0" style={{ width: '100%', height: '100%' }}>
            <Stage width={width} height={gameHeight || 0} options={{ backgroundColor: 0x7ab5ff }}>
              {/* Re-propagate context because contexts are not shared between renderers.
https://github.com/michalochman/react-pixi-fiber/issues/145#issuecomment-531549215 */}
              <ConvexProvider client={convex}>
                  <PixiGame
                    game={game}
                    worldId={worldId}
                    engineId={engineId}
                    width={width}
                    height={gameHeight || 0}
                    historicalTime={historicalTime}
                    setSelectedElement={setSelectedElement}
                    scrollable={scrollable}
                  />
              </ConvexProvider>
            </Stage>
          </div>
        </div>
        {/* Right column area - 40% */}
        <div
          className="flex flex-col overflow-hidden w-[40%] px-2 py-2 border-l-8 border-brown-900 bg-brown-800 text-brown-100"
          ref={scrollViewRef}
          style={gameHeight > 0 ? { height: `${gameHeight}px`, minHeight: `${gameHeight}px` } : undefined}
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
