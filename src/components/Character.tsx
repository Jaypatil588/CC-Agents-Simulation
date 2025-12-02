import { BaseTexture, ISpritesheetData, Spritesheet } from 'pixi.js';
import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatedSprite, Container, Graphics, Text } from '@pixi/react';
import * as PIXI from 'pixi.js';

export const Character = ({
  textureUrl,
  spritesheetData,
  x,
  y,
  orientation,
  isMoving = false,
  isThinking = false,
  isSpeaking = false,
  emoji = '',
  isViewer = false,
  speed = 0.1,
  onClick,
  recentMessage,
}: {
  // Path to the texture packed image.
  textureUrl: string;
  // The data for the spritesheet.
  spritesheetData: ISpritesheetData;
  // The pose of the NPC.
  x: number;
  y: number;
  orientation: number;
  isMoving?: boolean;
  // Shows a thought bubble if true.
  isThinking?: boolean;
  // Shows a speech bubble if true.
  isSpeaking?: boolean;
  emoji?: string;
  // Highlights the player.
  isViewer?: boolean;
  // The speed of the animation. Can be tuned depending on the side and speed of the NPC.
  speed?: number;
  onClick: () => void;
  // Most recent message for popup display
  recentMessage?: { text: string; timestamp: number } | null;
}) => {
  const [spriteSheet, setSpriteSheet] = useState<Spritesheet>();
  const [showMessagePopup, setShowMessagePopup] = useState(false);
  const popupTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    const parseSheet = async () => {
      const sheet = new Spritesheet(
        BaseTexture.from(textureUrl, {
          scaleMode: PIXI.SCALE_MODES.NEAREST,
        }),
        spritesheetData,
      );
      await sheet.parse();
      setSpriteSheet(sheet);
    };
    void parseSheet();
  }, []);

  // Show popup when recent message changes, auto-hide after 10 seconds
  useEffect(() => {
    if (recentMessage && recentMessage.text) {
      setShowMessagePopup(true);
      
      // Clear existing timeout
      if (popupTimeoutRef.current) {
        clearTimeout(popupTimeoutRef.current);
      }
      
      // Set new timeout to hide after 10 seconds
      popupTimeoutRef.current = setTimeout(() => {
        setShowMessagePopup(false);
      }, 10000);
      
      return () => {
        if (popupTimeoutRef.current) {
          clearTimeout(popupTimeoutRef.current);
        }
      };
    } else {
      setShowMessagePopup(false);
    }
  }, [recentMessage]);

  // The first "left" is "right" but reflected.
  const roundedOrientation = Math.floor(orientation / 90);
  const direction = ['right', 'down', 'left', 'up'][roundedOrientation];

  // Prevents the animation from stopping when the texture changes
  // (see https://github.com/pixijs/pixi-react/issues/359)
  const ref = useRef<PIXI.AnimatedSprite | null>(null);
  useEffect(() => {
    if (isMoving) {
      ref.current?.play();
    }
  }, [direction, isMoving]);

  if (!spriteSheet) return null;

  let blockOffset = { x: 0, y: 0 };
  switch (roundedOrientation) {
    case 2:
      blockOffset = { x: -20, y: 0 };
      break;
    case 0:
      blockOffset = { x: 20, y: 0 };
      break;
    case 3:
      blockOffset = { x: 0, y: -20 };
      break;
    case 1:
      blockOffset = { x: 0, y: 20 };
      break;
  }

  return (
    <Container x={x} y={y} interactive={true} pointerdown={onClick} cursor="pointer">
      {isThinking && (
        // TODO: We'll eventually have separate assets for thinking and speech animations.
        <Text x={-20} y={-10} scale={{ x: -0.8, y: 0.8 }} text={'💭'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isSpeaking && (
        // TODO: We'll eventually have separate assets for thinking and speech animations.
        <Text x={18} y={-10} scale={0.8} text={'💬'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isViewer && <ViewerIndicator />}
      <AnimatedSprite
        ref={ref}
        isPlaying={isMoving}
        textures={spriteSheet.animations[direction]}
        animationSpeed={speed}
        anchor={{ x: 0.5, y: 0.5 }}
        scale={{ x: 3, y: 3 }}
      />
      {emoji && (
        <Text x={0} y={-24} scale={{ x: -1.6, y: 1.6 }} text={emoji} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {showMessagePopup && recentMessage && (
        <MessagePopup text={recentMessage.text} />
      )}
    </Container>
  );
};

function MessagePopup({ text }: { text: string }) {
  // Split text into lines (max 30 chars per line)
  const maxCharsPerLine = 30;
  const textLines: string[] = [];
  const words = text.split(' ');
  let currentLine = '';
  
  for (const word of words) {
    if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    } else {
      if (currentLine) textLines.push(currentLine);
      currentLine = word.length > maxCharsPerLine ? word.substring(0, maxCharsPerLine) : word;
    }
  }
  if (currentLine) textLines.push(currentLine);
  
  const maxWidth = 200;
  const padding = 8;
  const lineHeight = 16;
  const height = textLines.length * lineHeight + padding * 2;
  const width = Math.min(maxWidth, Math.max(100, textLines.reduce((max, line) => Math.max(max, line.length * 6), 0) + padding * 2));
  
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    // Draw speech bubble background
    g.beginFill(0xffffff, 0.95);
    g.lineStyle(2, 0x000000, 1);
    // Rounded rectangle for bubble
    g.drawRoundedRect(-width / 2, -height - 40, width, height, 8);
    g.endFill();
  }, [width, height]);

  return (
    <Container y={-40}>
      <Graphics draw={draw} />
      {textLines.map((line, idx) => (
        <Text
          key={idx}
          x={-width / 2 + padding}
          y={-height - 40 + padding + idx * lineHeight}
          text={line}
          style={{
            fontSize: 12,
            fill: 0x000000,
          }}
        />
      ))}
    </Container>
  );
}

function ViewerIndicator() {
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0xffff0b, 0.5);
    g.drawRoundedRect(-10, 10, 20, 10, 100);
    g.endFill();
  }, []);

  return <Graphics draw={draw} />;
}
