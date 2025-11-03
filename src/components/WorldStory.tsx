import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { useEffect, useRef } from 'react';

export function WorldStory({
  worldId,
  scrollViewRef,
}: {
  worldId: Id<'worlds'>;
  scrollViewRef: React.RefObject<HTMLDivElement>;
}) {
  const storyEntries = useQuery(api.worldStory.getWorldStory, { worldId, limit: 100 });
  const worldPlot = useQuery(api.worldStory.getWorldPlot, { worldId });
  const initializePlot = useMutation(api.worldStory.initializePlot);
  
  const storyScrollRef = useRef<HTMLDivElement>(null);

  // Initialize plot if it doesn't exist
  useEffect(() => {
    if (worldPlot === undefined) return;
    if (worldPlot === null) {
      console.log('Initializing world plot...');
      initializePlot({ worldId }).catch(console.error);
    }
  }, [worldPlot, worldId, initializePlot]);

  // Auto-scroll the story section to the bottom when new entries arrive
  useEffect(() => {
    if (storyScrollRef.current && storyEntries && storyEntries.length > 0) {
      storyScrollRef.current.scrollTo({
        top: storyScrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [storyEntries]);

  // Show loading or initialization state
  if (!worldPlot) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="box mb-4">
          <h2 className="bg-brown-700 p-3 font-display text-3xl sm:text-4xl tracking-wider shadow-solid text-center">
            📜 The Chronicles
          </h2>
        </div>
        <div className="desc max-w-md">
          <p className="leading-tight -m-4 bg-brown-700 text-base sm:text-sm">
            <i>
              The Dungeon Master prepares the tale... An epic story of conflict and adventure is
              being woven. Stand by as the realm's destiny unfolds...
            </i>
          </p>
        </div>
        <div className="mt-6 text-brown-400 text-sm animate-pulse">
          <p>⚔️ Generating epic DnD plot...</p>
        </div>
      </div>
    );
  }

  // Show initial plot if no story entries yet
  if (!storyEntries || storyEntries.length === 0) {
    return (
      <div className="h-full flex flex-col p-4 overflow-y-auto">
        <div className="box mb-4">
          <h2 className="bg-brown-700 p-3 font-display text-3xl sm:text-4xl tracking-wider shadow-solid text-center">
            📜 The Chronicles
          </h2>
        </div>

        <div className="desc mb-4 flex-shrink-0">
          <div className="bg-brown-700 p-4 text-base sm:text-sm">
            <div className="mb-3 pb-2 border-b-2 border-brown-600">
              <p className="text-clay-400 font-bold text-center text-lg">
                ⚔️ THE TALE BEGINS ⚔️
              </p>
            </div>
            <p className="text-brown-100 leading-relaxed whitespace-pre-line first-letter:text-3xl first-letter:font-bold first-letter:text-clay-400">
              {worldPlot.initialPlot}
            </p>
          </div>
        </div>

        <div className="text-center text-brown-400 text-sm animate-pulse">
          <p>✨ Awaiting the first actions of our heroes...</p>
          <p className="text-xs mt-2">The story will unfold in real-time as characters interact</p>
        </div>
      </div>
    );
  }

  // Show the continuous story with 50/50 split
  return (
    <div className="flex flex-col h-full gap-1">
      {/* Top 50% - Current Plot Summary (updates every 10s) */}
      <div 
        className="flex flex-col min-h-0 relative group" 
        style={{ flex: '0 0 50%' }}
        title="🎭 PLOT SUMMARY - Updates every 10s"
      >
        {/* Hover tooltip */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-clay-700 px-3 py-1 rounded text-xs text-clay-200 font-display pointer-events-none whitespace-nowrap">
          🎭 PLOT SUMMARY
        </div>
        
        <div className="desc flex-1 overflow-hidden flex flex-col min-h-0">
          <div className="bg-brown-700 p-2 h-full flex flex-col overflow-hidden">
            <p className="text-brown-100 text-xs leading-snug italic flex-1 overflow-hidden">
              {worldPlot.currentSummary}
            </p>
            <div className="pt-1 mt-1 border-t border-brown-600 text-[10px] text-brown-400 flex-shrink-0">
              <div className="flex justify-between items-center">
                <span>Stage: <span className="text-clay-400 font-bold uppercase text-[10px]">{worldPlot.storyProgress}</span></span>
                <span className="text-brown-500">↻ 10s</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom 50% - Real-Time Story (auto-scrolling, updates every 5s) */}
      <div 
        className="flex flex-col min-h-0 relative group" 
        style={{ flex: '1 1 50%' }}
        title="⚔️ LIVE ADVENTURE - Updates every 5s"
      >
        {/* Hover tooltip */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-clay-700 px-3 py-1 rounded text-xs text-clay-200 font-display pointer-events-none whitespace-nowrap">
          ⚔️ LIVE ADVENTURE
        </div>
        
        <div className="desc flex-1 overflow-hidden flex flex-col min-h-0">
          <div 
            ref={storyScrollRef}
            className="bg-brown-700 p-2 overflow-y-auto h-full"
          >
            {/* Render story as continuous narrative */}
            {storyEntries.map((entry, index) => (
              <div key={entry._id} className="mb-2 animate-fadeIn">
                {/* Show conflict type badge */}
                {entry.conflictType && (
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-[9px] px-1 py-0.5 bg-clay-700 text-clay-200 rounded font-bold uppercase">{entry.conflictType}</span>
                    <div className="flex-grow h-px bg-brown-600"></div>
                  </div>
                )}

                {/* The narrative paragraph */}
                <p className="text-brown-100 text-xs leading-snug first-letter:text-sm first-letter:font-bold first-letter:text-clay-400">
                  {entry.narrative}
                </p>

                {/* Separator between entries */}
                {index < storyEntries.length - 1 && (
                  <div className="h-px bg-brown-600 opacity-30 mt-2"></div>
                )}
              </div>
            ))}

            {/* Continuous indicator at the bottom */}
            <div className="text-center text-brown-400 text-[9px] italic pt-2 mt-2 border-t border-brown-600">
              <p className="animate-pulse">📝 {storyEntries.length} passages • Updates every 5s</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

