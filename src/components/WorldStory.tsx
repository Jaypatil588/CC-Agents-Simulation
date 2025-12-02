import { useQuery, useMutation } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { Id } from '../../convex/_generated/dataModel';
import { useEffect, useRef, useState } from 'react';
import ReactModal from 'react-modal';

export function WorldStory({
  worldId,
  scrollViewRef,
}: {
  worldId: Id<'worlds'>;
  scrollViewRef: React.RefObject<HTMLDivElement>;
}) {
  const storyEntries = useQuery(api.worldStory.getWorldStory, { worldId, limit: 100 });
  const worldPlot = useQuery(api.worldStory.getWorldPlot, { worldId });
  const setInitialPlot = useMutation(api.worldStory.setInitialPlot);
  const resetStory = useMutation(api.worldStory.resetWorldStory);
  
  const storyScrollRef = useRef<HTMLDivElement>(null);
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [hasShownModal, setHasShownModal] = useState(false);
  const [plotInput, setPlotInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Show modal when story is complete (only once)
  useEffect(() => {
    if (worldPlot?.isComplete && worldPlot?.finalSummary && !hasShownModal) {
      setShowCompletionModal(true);
      setHasShownModal(true);
    }
    // Reset modal state when story is reset (isComplete becomes false)
    if (worldPlot && !worldPlot.isComplete && hasShownModal) {
      setHasShownModal(false);
      setShowCompletionModal(false);
    }
  }, [worldPlot?.isComplete, worldPlot?.finalSummary, hasShownModal]);

  const handleSubmitPlot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!plotInput.trim() || isSubmitting) return;
    
    setIsSubmitting(true);
    try {
      await setInitialPlot({ worldId, initialPlot: plotInput });
      setPlotInput('');
    } catch (error) {
      console.error('Failed to set initial plot:', error);
      alert('Failed to set initial plot. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auto-scroll the story section to the bottom when new entries arrive
  useEffect(() => {
    if (storyScrollRef.current && storyEntries && storyEntries.length > 0) {
      storyScrollRef.current.scrollTo({
        top: storyScrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [storyEntries]);

  // Show input form when no plot exists
  if (!worldPlot) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <div className="box mb-4">
          <h2 className="bg-brown-700 p-3 font-display text-3xl sm:text-4xl tracking-wider shadow-solid text-center">
            📜 The Chronicles
          </h2>
        </div>
        <div className="desc max-w-md w-full">
          <div className="bg-brown-700 p-4 text-base sm:text-sm">
            <p className="text-brown-100 mb-4">
              <strong className="text-clay-400">Create Your Story Theme</strong>
            </p>
            <p className="text-brown-200 text-sm mb-4">
              Provide the initial theme or plot for your story. This will guide how agents interact and how the story evolves.
            </p>
            <form onSubmit={handleSubmitPlot} className="flex flex-col gap-3">
              <textarea
                value={plotInput}
                onChange={(e) => setPlotInput(e.target.value)}
                placeholder="e.g., A corporate espionage thriller set in a futuristic city where AI and humans compete for control..."
                className="w-full p-3 bg-brown-800 text-brown-100 border-2 border-brown-600 rounded resize-none focus:outline-none focus:border-clay-500 min-h-[120px] text-sm"
                disabled={isSubmitting}
              />
              <button
                type="submit"
                disabled={!plotInput.trim() || isSubmitting}
                className="bg-clay-700 hover:bg-clay-600 disabled:bg-brown-800 disabled:text-brown-500 disabled:cursor-not-allowed text-clay-100 px-6 py-2 rounded font-bold uppercase tracking-wide transition-all hover:scale-105 active:scale-95 border-2 border-clay-900 disabled:border-brown-900"
              >
                {isSubmitting ? 'Creating...' : 'Start Story'}
              </button>
            </form>
          </div>
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
      
      {/* Story Completion Modal */}
      <ReactModal
        isOpen={showCompletionModal}
        onRequestClose={() => setShowCompletionModal(false)}
        style={completionModalStyles}
        contentLabel="Story Complete"
        ariaHideApp={false}
      >
        <div className="font-body text-brown-100">
          <h2 className="text-center text-4xl font-bold font-display text-clay-400 mb-6">
            🎭 The Tale Has Ended 🎭
          </h2>
          
          <div className="bg-brown-800 p-4 rounded mb-6 border-2 border-brown-600">
            <h3 className="text-clay-300 font-bold text-lg mb-3 text-center">What Happened:</h3>
            <div className="text-brown-100 text-base leading-relaxed whitespace-pre-line">
              {worldPlot?.finalSummary?.split('\n').map((line, idx) => (
                <p key={idx} className="mb-2">{line}</p>
              ))}
            </div>
          </div>
          
          <div className="flex gap-4 justify-center">
            <button
              onClick={() => {
                setShowCompletionModal(false);
              }}
              className="bg-brown-700 hover:bg-brown-600 text-brown-100 px-6 py-3 rounded font-bold uppercase tracking-wide transition-all hover:scale-105 active:scale-95 border-2 border-brown-900"
            >
              Continue Reading
            </button>
            <button
              onClick={async () => {
                if (confirm('Reset the simulation? This will start a new story with a fresh plot.')) {
                  try {
                    setShowCompletionModal(false);
                    await resetStory({ worldId });
                  } catch (error) {
                    console.error('Failed to reset story:', error);
                    alert('Failed to reset story. Please try again.');
                  }
                }
              }}
              className="bg-clay-700 hover:bg-clay-600 text-clay-100 px-6 py-3 rounded font-bold uppercase tracking-wide transition-all hover:scale-105 active:scale-95 border-2 border-clay-900"
            >
              🔄 Reset Simulation
            </button>
          </div>
        </div>
      </ReactModal>
    </div>
  );
}

const completionModalStyles = {
  overlay: {
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    zIndex: 20,
  },
  content: {
    top: '50%',
    left: '50%',
    right: 'auto',
    bottom: 'auto',
    marginRight: '-50%',
    transform: 'translate(-50%, -50%)',
    maxWidth: '600px',
    width: '90%',
    border: '10px solid rgb(139, 90, 43)',
    borderRadius: '0',
    background: 'rgb(55, 48, 38)',
    color: 'white',
    fontFamily: '"Upheaval Pro", "sans-serif"',
    padding: '30px',
  },
};

