// Based on https://codepen.io/inlet/pen/yLVmPWv.
// Copyright (c) 2018 Patrick Brouwer, distributed under the MIT license.

import { PixiComponent, useApp } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { Application } from 'pixi.js';
import { MutableRefObject, ReactNode } from 'react';

export type ViewportProps = {
  app: Application;
  viewportRef?: MutableRefObject<Viewport | undefined>;

  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  scrollable?: boolean;
  initialScale?: number;
  children?: ReactNode;
};

// https://davidfig.github.io/pixi-viewport/jsdoc/Viewport.html
export default PixiComponent('Viewport', {
  create(props: ViewportProps) {
    const { app, children, viewportRef, scrollable = true, initialScale, ...viewportProps } = props;
    const viewport = new Viewport({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      events: app.renderer.events,
      passiveWheel: false,
      ...viewportProps,
    });
    if (viewportRef) {
      viewportRef.current = viewport;
    }
    
    // Calculate scale to fit entire map to width (height matches aspect ratio)
    const fitToScreenScale = initialScale ?? (props.screenWidth / props.worldWidth);
    
    // Set viewport size to match screen dimensions
    viewport.screenWidth = props.screenWidth;
    viewport.screenHeight = props.screenHeight;
    
    // Conditionally add plugins based on scrollable state
    if (scrollable) {
      viewport
        .drag()
        .pinch({})
        .wheel()
        .decelerate()
        .clamp({ direction: 'all', underflow: 'center' })
        .clampZoom({
          minScale: fitToScreenScale,
          maxScale: 3.0,
        });
    } else {
      // When not scrollable, don't add interaction plugins
      // Calculate scaled dimensions to ensure full map is visible
      const scaledWorldWidth = props.worldWidth * fitToScreenScale;
      const scaledWorldHeight = props.worldHeight * fitToScreenScale;
      
      // If scaled world fits in screen, center it; otherwise show from edge to edge
      if (scaledWorldWidth <= props.screenWidth && scaledWorldHeight <= props.screenHeight) {
        viewport.clamp({ 
          direction: 'all', 
          underflow: 'center',
        });
      } else {
        // Show full map from edge to edge
        viewport.clamp({ 
          direction: 'all',
          left: 0,
          right: props.worldWidth,
          top: 0,
          bottom: props.worldHeight,
        });
      }
      viewport.clampZoom({
        minScale: fitToScreenScale,
        maxScale: fitToScreenScale,
      });
    }
    
    // Set initial zoom to fit the entire map
    viewport.setZoom(fitToScreenScale);
    // Position viewport to show the entire map
    // When scaled, the world dimensions in screen space
    const scaledWorldWidth = props.worldWidth * fitToScreenScale;
    const scaledWorldHeight = props.worldHeight * fitToScreenScale;
    
    // If scaled world fits in screen, center it; otherwise position to show full map
    if (scaledWorldWidth <= props.screenWidth && scaledWorldHeight <= props.screenHeight) {
      // Center the world in the viewport
      viewport.moveCenter(props.worldWidth / 2, props.worldHeight / 2);
    } else {
      // Position to show full map from top-left, accounting for scale
      // The viewport center should be at (worldWidth/2, worldHeight/2) to show full map
      viewport.moveCenter(props.worldWidth / 2, props.worldHeight / 2);
    }
    
    return viewport;
  },
  applyProps(viewport: any, oldProps: any, newProps: any) {
    const { scrollable: oldScrollable, initialScale: oldInitialScale } = oldProps;
    const { scrollable: newScrollable = true, initialScale: newInitialScale } = newProps;
    
    // Update viewport size if screen dimensions changed
    if (oldProps.screenWidth !== newProps.screenWidth || oldProps.screenHeight !== newProps.screenHeight) {
      viewport.screenWidth = newProps.screenWidth;
      viewport.screenHeight = newProps.screenHeight;
    }
    
    // Handle scrollable state changes
    if (oldScrollable !== newScrollable) {
      const fitToScreenScale = newInitialScale ?? (newProps.screenWidth / newProps.worldWidth);
      
      if (newScrollable) {
        // Enable scrolling - add interaction plugins
        viewport.drag().pinch({}).wheel().decelerate();
        viewport.clamp({ direction: 'all', underflow: 'center' });
        viewport.clampZoom({
          minScale: fitToScreenScale,
          maxScale: 3.0,
        });
      } else {
        // Disable scrolling - remove interaction plugins
        viewport.plugins.remove('drag');
        viewport.plugins.remove('pinch');
        viewport.plugins.remove('wheel');
        viewport.plugins.remove('decelerate');
        // Update clamp bounds
        viewport.clamp({ 
          direction: 'all', 
          underflow: 'center',
          left: 0,
          right: newProps.worldWidth,
          top: 0,
          bottom: newProps.worldHeight,
        });
        viewport.clampZoom({
          minScale: fitToScreenScale,
          maxScale: fitToScreenScale,
        });
        // Reset to fit-to-screen view
        viewport.setZoom(fitToScreenScale);
        viewport.moveCenter(newProps.worldWidth / 2, newProps.worldHeight / 2);
      }
    }
    
    Object.keys(newProps).forEach((p) => {
      if (p !== 'app' && p !== 'viewportRef' && p !== 'children' && p !== 'scrollable' && p !== 'initialScale' && oldProps[p] !== newProps[p]) {
        // @ts-expect-error Ignoring TypeScript here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        viewport[p] = newProps[p];
      }
    });
  },
});
