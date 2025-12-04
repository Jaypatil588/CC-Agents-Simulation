import { useCallback, useEffect, useRef, useState } from 'react';
import volumeImg from '../../../assets/volume.svg';
import { sound } from '@pixi/sound';
import Button from './Button';
import { useQuery } from 'convex/react';
import { api } from '../../../convex/_generated/api';

export default function MusicButton() {
  const worldStatus = useQuery(api.world.defaultWorldStatus);
  const worldId = worldStatus?.worldId;
  const musicData = useQuery(api.music.getBackgroundMusic, worldId ? { worldId } : 'skip');
  const [isPlaying, setPlaying] = useState(false);
  const previousStageRef = useRef<string | null>(null);

  useEffect(() => {
    if (musicData) {
      const { musicUrl, stage } = musicData;
      
      // Only change music if the stage has actually changed
      if (stage && stage !== previousStageRef.current) {
        const wasPlaying = sound.exists('background') && sound.isPlaying('background');
        previousStageRef.current = stage;
        
        // Remove existing sound if it exists
        if (sound.exists('background')) {
          sound.stop('background');
          sound.remove('background');
        }
        
        // Add the new music with 20% volume
        sound.add('background', musicUrl).loop = true;
        sound.volume('background', 0.2);
        
        // If music was playing before, restart it with the new URL
        if (wasPlaying) {
          sound.play('background').catch((error) => {
            console.error('Error playing background music:', error);
          });
          setPlaying(true);
        }
      } else if (previousStageRef.current === null && musicUrl) {
        // Initial load - set up music but don't play automatically
        if (!sound.exists('background')) {
          sound.add('background', musicUrl).loop = true;
          sound.volume('background', 0.2);
          // Don't auto-play on initial load
        }
        // Store the stage even if it's null for initial load tracking
        if (stage) {
          previousStageRef.current = stage;
        } else {
          previousStageRef.current = 'default'; // Mark as initialized
        }
      }
    }
  }, [musicData]);

  const flipSwitch = async () => {
    if (isPlaying) {
      sound.stop('background');
    } else {
      await sound.play('background');
    }
    setPlaying(!isPlaying);
  };

  const handleKeyPress = useCallback(
    (event: { key: string }) => {
      if (event.key === 'm' || event.key === 'M') {
        void flipSwitch();
      }
    },
    [flipSwitch],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [handleKeyPress]);

  return (
    <>
      <Button
        onClick={() => void flipSwitch()}
        className="hidden lg:block"
        title="Play AI generated music (press m to play/mute)"
        imgUrl={volumeImg}
      >
        {isPlaying ? 'Mute' : 'Music'}
      </Button>
    </>
  );
}
