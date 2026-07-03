// @ts-nocheck
'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Mask, Point, Rectangle, CanvasState, ToolOptions } from './types';

/**
 * HTML5 Canvas interface for mask creation and image editing
 * Provides interactive tools for brush, rectangle, and circle mask creation
 */

interface CanvasInterfaceProps {
  imageData?: string; // base64 image data
  onMaskCreated?: (mask: Mask) => void;
  onMaskUpdated?: (maskId: string, mask: Mask) => void;
  onMaskDeleted?: (maskId: string) => void;
  className?: string;
  width?: number;
  height?: number;
}

interface DrawingState {
  isDrawing: boolean;
  startPoint: Point | null;
  currentPath: Point[];
  currentMask: Mask | null;
}

export const CanvasInterface: React.FC<CanvasInterfaceProps> = ({
  imageData,
  onMaskCreated,
  onMaskUpdated,
  onMaskDeleted,
  className = '',
  width = 800,
  height = 600
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const [canvasState, setCanvasState] = useState<CanvasState>({
    image: '',
    masks: [],
    activeTool: 'none',
    zoom: 1,
    pan: { x: 0, y: 0 }
  });

  const [toolOptions, setToolOptions] = useState<ToolOptions>({
    brushSize: 20,
    opacity: 0.5,
    color: '#ff0000'
  });

  const [drawingState, setDrawingState] = useState<DrawingState>({
    isDrawing: false,
    startPoint: null,
    currentPath: [],
    currentMask: null
  });

  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);

  // Load image when imageData changes
  useEffect(() => {
    if (imageData) {
      const img = new Image();
      img.onload = () => {
        setLoadedImage(img);
        setCanvasState(prev => ({ ...prev, image: imageData }));
      };
      img.src = imageData;
    }
  }, [imageData]);

  const drawMask = useCallback((
    ctx: CanvasRenderingContext2D,
    mask: Mask,
    index: number,
    isPreview = false
  ) => {
    ctx.save();

    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    const color = colors[index % colors.length];
    const opacity = isPreview ? 0.3 : toolOptions.opacity || 0.5;

    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    switch (mask.type) {
      case 'brush':
        if (mask.coordinates.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(mask.coordinates[0].x, mask.coordinates[0].y);
          for (let i = 1; i < mask.coordinates.length; i++) {
            ctx.lineTo(mask.coordinates[i].x, mask.coordinates[i].y);
          }
          ctx.lineWidth = toolOptions.brushSize || 20;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        break;
      case 'rectangle':
        if (mask.coordinates.length >= 2) {
          const start = mask.coordinates[0];
          const end = mask.coordinates[mask.coordinates.length - 1];
          const width = end.x - start.x;
          const height = end.y - start.y;
          ctx.fillRect(start.x, start.y, width, height);
          ctx.strokeRect(start.x, start.y, width, height);
        }
        break;
      case 'circle':
        if (mask.coordinates.length >= 2) {
          const start = mask.coordinates[0];
          const end = mask.coordinates[mask.coordinates.length - 1];
          const radius = Math.sqrt(
            Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
          );
          ctx.beginPath();
          ctx.arc(start.x, start.y, radius, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
        }
        break;
    }

    ctx.restore();
  }, [toolOptions.brushSize, toolOptions.opacity]);

  // Redraw canvas when state changes
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    
    if (!canvas || !imageCanvas || !maskCanvas) return;

    const ctx = canvas.getContext('2d');
    const imageCtx = imageCanvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    
    if (!ctx || !imageCtx || !maskCtx) return;

    // Clear all canvases
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    imageCtx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

    // Draw image if loaded
    if (loadedImage) {
      const scale = Math.min(
        canvas.width / loadedImage.width,
        canvas.height / loadedImage.height
      );
      const scaledWidth = loadedImage.width * scale * canvasState.zoom;
      const scaledHeight = loadedImage.height * scale * canvasState.zoom;
      const x = (canvas.width - scaledWidth) / 2 + canvasState.pan.x;
      const y = (canvas.height - scaledHeight) / 2 + canvasState.pan.y;

      imageCtx.drawImage(loadedImage, x, y, scaledWidth, scaledHeight);
    }

    // Draw existing masks
    canvasState.masks.forEach((mask, index) => {
      drawMask(maskCtx, mask, index);
    });

    // Draw current mask being created
    if (drawingState.currentMask) {
      drawMask(maskCtx, drawingState.currentMask, canvasState.masks.length, true);
    }

    // Composite all layers
    ctx.drawImage(imageCanvas, 0, 0);
    ctx.drawImage(maskCanvas, 0, 0);
  }, [canvasState, drawMask, drawingState, loadedImage]);

  // Get mouse position relative to canvas
  const getMousePos = (e: React.MouseEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };

    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  // Calculate mask bounds
  const calculateBounds = (coordinates: Point[]): Rectangle => {
    if (coordinates.length === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const xs = coordinates.map(p => p.x);
    const ys = coordinates.map(p => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  };

  // Create mask ImageData
  const createMaskImageData = (coordinates: Point[], type: Mask['type']): ImageData => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      return new ImageData(width, height);
    }

    ctx.fillStyle = 'white';
    ctx.globalAlpha = 1;

    switch (type) {
      case 'brush':
        if (coordinates.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(coordinates[0].x, coordinates[0].y);
          for (let i = 1; i < coordinates.length; i++) {
            ctx.lineTo(coordinates[i].x, coordinates[i].y);
          }
          ctx.lineWidth = toolOptions.brushSize || 20;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
        break;
      case 'rectangle':
        if (coordinates.length >= 2) {
          const start = coordinates[0];
          const end = coordinates[coordinates.length - 1];
          const rectWidth = end.x - start.x;
          const rectHeight = end.y - start.y;
          ctx.fillRect(start.x, start.y, rectWidth, rectHeight);
        }
        break;
      case 'circle':
        if (coordinates.length >= 2) {
          const start = coordinates[0];
          const end = coordinates[coordinates.length - 1];
          const radius = Math.sqrt(
            Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
          );
          ctx.beginPath();
          ctx.arc(start.x, start.y, radius, 0, 2 * Math.PI);
          ctx.fill();
        }
        break;
    }

    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  };

  // Mouse event handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (canvasState.activeTool === 'none') return;

    const pos = getMousePos(e);
    const maskId = `mask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const newMask: Mask = {
      id: maskId,
      type: canvasState.activeTool,
      coordinates: [pos],
      bounds: { x: pos.x, y: pos.y, width: 0, height: 0 },
      opacity: toolOptions.opacity || 0.5,
      data: new ImageData(width, height)
    };

    setDrawingState({
      isDrawing: true,
      startPoint: pos,
      currentPath: [pos],
      currentMask: newMask
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingState.isDrawing || !drawingState.currentMask) return;

    const pos = getMousePos(e);
    
    setDrawingState(prev => {
      const newPath = canvasState.activeTool === 'brush' 
        ? [...prev.currentPath, pos]
        : [prev.startPoint!, pos];

      const updatedMask: Mask = {
        ...prev.currentMask!,
        coordinates: newPath,
        bounds: calculateBounds(newPath)
      };

      return {
        ...prev,
        currentPath: newPath,
        currentMask: updatedMask
      };
    });

    redrawCanvas();
  };

  const handleMouseUp = () => {
    if (!drawingState.isDrawing || !drawingState.currentMask) return;

    // Finalize the mask
    const finalMask: Mask = {
      ...drawingState.currentMask,
      data: createMaskImageData(drawingState.currentMask.coordinates, drawingState.currentMask.type)
    };

    // Add to masks and notify parent
    setCanvasState(prev => ({
      ...prev,
      masks: [...prev.masks, finalMask]
    }));

    if (onMaskCreated) {
      onMaskCreated(finalMask);
    }

    // Reset drawing state
    setDrawingState({
      isDrawing: false,
      startPoint: null,
      currentPath: [],
      currentMask: null
    });

    redrawCanvas();
  };

  // Tool activation methods
  const activateBrushTool = (size: number = 20, opacity: number = 0.5) => {
    setCanvasState(prev => ({ ...prev, activeTool: 'brush' }));
    setToolOptions(prev => ({ ...prev, brushSize: size, opacity }));
  };

  const activateRectangleTool = () => {
    setCanvasState(prev => ({ ...prev, activeTool: 'rectangle' }));
  };

  const activateCircleTool = () => {
    setCanvasState(prev => ({ ...prev, activeTool: 'circle' }));
  };

  const clearMasks = () => {
    setCanvasState(prev => ({ ...prev, masks: [] }));
    redrawCanvas();
  };

  const setZoom = (level: number) => {
    setCanvasState(prev => ({ ...prev, zoom: Math.max(0.1, Math.min(5, level)) }));
    redrawCanvas();
  };

  // Redraw when state changes
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  return (
    <div className={`canvas-interface ${className}`}>
      {/* Tool Controls */}
      <div className="tool-controls mb-4 flex gap-2 flex-wrap">
        <button
          onClick={() => activateBrushTool()}
          className={`px-3 py-2 rounded ${
            canvasState.activeTool === 'brush' 
              ? 'bg-blue-500 text-white' 
              : 'bg-gray-200 text-gray-700'
          }`}
        >
          Brush
        </button>
        <button
          onClick={activateRectangleTool}
          className={`px-3 py-2 rounded ${
            canvasState.activeTool === 'rectangle' 
              ? 'bg-blue-500 text-white' 
              : 'bg-gray-200 text-gray-700'
          }`}
        >
          Rectangle
        </button>
        <button
          onClick={activateCircleTool}
          className={`px-3 py-2 rounded ${
            canvasState.activeTool === 'circle' 
              ? 'bg-blue-500 text-white' 
              : 'bg-gray-200 text-gray-700'
          }`}
        >
          Circle
        </button>
        <button
          onClick={clearMasks}
          className="px-3 py-2 rounded bg-red-500 text-white"
        >
          Clear Masks
        </button>
        
        {/* Brush Size Control */}
        {canvasState.activeTool === 'brush' && (
          <div className="flex items-center gap-2">
            <label className="text-sm">Size:</label>
            <input
              type="range"
              min="5"
              max="50"
              value={toolOptions.brushSize || 20}
              onChange={(e) => setToolOptions(prev => ({ 
                ...prev, 
                brushSize: parseInt(e.target.value) 
              }))}
              className="w-20"
            />
            <span className="text-sm">{toolOptions.brushSize}</span>
          </div>
        )}

        {/* Opacity Control */}
        <div className="flex items-center gap-2">
          <label className="text-sm">Opacity:</label>
          <input
            type="range"
            min="0.1"
            max="1"
            step="0.1"
            value={toolOptions.opacity || 0.5}
            onChange={(e) => setToolOptions(prev => ({ 
              ...prev, 
              opacity: parseFloat(e.target.value) 
            }))}
            className="w-20"
          />
          <span className="text-sm">{Math.round((toolOptions.opacity || 0.5) * 100)}%</span>
        </div>

        {/* Zoom Control */}
        <div className="flex items-center gap-2">
          <label className="text-sm">Zoom:</label>
          <button
            onClick={() => setZoom(canvasState.zoom - 0.1)}
            className="px-2 py-1 rounded bg-gray-200 text-gray-700"
          >
            -
          </button>
          <span className="text-sm">{Math.round(canvasState.zoom * 100)}%</span>
          <button
            onClick={() => setZoom(canvasState.zoom + 0.1)}
            className="px-2 py-1 rounded bg-gray-200 text-gray-700"
          >
            +
          </button>
        </div>
      </div>

      {/* Canvas Container */}
      <div className="canvas-container relative border border-gray-300 rounded">
        {/* Hidden canvases for layered rendering */}
        <canvas
          ref={imageCanvasRef}
          width={width}
          height={height}
          className="absolute top-0 left-0 pointer-events-none"
          style={{ display: 'none' }}
        />
        <canvas
          ref={maskCanvasRef}
          width={width}
          height={height}
          className="absolute top-0 left-0 pointer-events-none"
          style={{ display: 'none' }}
        />
        
        {/* Main interactive canvas */}
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className="block cursor-crosshair"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>

      {/* Mask List */}
      {canvasState.masks.length > 0 && (
        <div className="mask-list mt-4">
          <h3 className="text-lg font-semibold mb-2">Created Masks ({canvasState.masks.length})</h3>
          <div className="space-y-2">
            {canvasState.masks.map((mask, index) => (
              <div key={mask.id} className="flex items-center justify-between p-2 bg-gray-100 rounded">
                <span className="text-sm">
                  {mask.type.charAt(0).toUpperCase() + mask.type.slice(1)} Mask {index + 1}
                </span>
                <button
                  onClick={() => {
                    setCanvasState(prev => ({
                      ...prev,
                      masks: prev.masks.filter(m => m.id !== mask.id)
                    }));
                    if (onMaskDeleted) {
                      onMaskDeleted(mask.id);
                    }
                    redrawCanvas();
                  }}
                  className="px-2 py-1 text-xs bg-red-500 text-white rounded"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default CanvasInterface;

// Export the interface methods for external use
export interface CanvasInterfaceMethods {
  loadImage: (imageData: string) => Promise<void>;
  activateBrushTool: (size?: number, opacity?: number) => void;
  activateRectangleTool: () => void;
  activateCircleTool: () => void;
  getMasks: () => Mask[];
  clearMasks: () => void;
  setZoom: (level: number) => void;
}
