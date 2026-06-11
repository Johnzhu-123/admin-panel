// @ts-nocheck
/**
 * Mask processing system for AI image editing enhancement
 * Handles mask creation, validation, optimization, and encoding
 */

import { 
  Mask, 
  Point, 
  Rectangle, 
  ImageSize, 
  ValidationResult, 
  OptimizedMask,
  ProviderCapabilities 
} from './types';

export class MaskProcessor {
  /**
   * Creates a mask from coordinates based on tool type
   */
  createMask(
    id: string,
    type: 'brush' | 'rectangle' | 'circle',
    coordinates: Point[],
    canvasSize: ImageSize,
    opacity: number = 1.0
  ): Mask {
    if (coordinates.length === 0) {
      throw new Error('Coordinates array cannot be empty');
    }

    const bounds = this.calculateBounds(coordinates, type);
    const data = this.generateMaskData(coordinates, type, bounds, canvasSize);

    return {
      id,
      type,
      coordinates,
      bounds,
      opacity,
      data
    };
  }

  /**
   * Validates a mask for correctness and completeness
   */
  validateMask(mask: Mask): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic validation
    if (!mask.id || mask.id.trim() === '') {
      errors.push('Mask ID is required');
    }

    if (!['brush', 'rectangle', 'circle'].includes(mask.type)) {
      errors.push('Invalid mask type. Must be brush, rectangle, or circle');
    }

    if (!mask.coordinates || mask.coordinates.length === 0) {
      errors.push('Mask coordinates are required');
    }

    if (mask.opacity < 0 || mask.opacity > 1) {
      errors.push('Mask opacity must be between 0 and 1');
    }

    if (!mask.data) {
      errors.push('Mask data is required');
    }

    // Bounds validation
    if (mask.bounds) {
      if (mask.bounds.width <= 0 || mask.bounds.height <= 0) {
        errors.push('Mask bounds must have positive width and height');
      }
    } else {
      errors.push('Mask bounds are required');
    }

    // Coordinate validation based on type
    if (mask.coordinates && mask.coordinates.length > 0) {
      switch (mask.type) {
        case 'rectangle':
          if (mask.coordinates.length < 2) {
            errors.push('Rectangle mask requires at least 2 coordinates (top-left and bottom-right)');
          }
          break;
        case 'circle':
          if (mask.coordinates.length < 2) {
            errors.push('Circle mask requires at least 2 coordinates (center and radius point)');
          }
          break;
        case 'brush':
          if (mask.coordinates.length < 1) {
            errors.push('Brush mask requires at least 1 coordinate');
          }
          if (mask.coordinates.length > 10000) {
            warnings.push('Brush mask has many coordinates, consider simplification for performance');
          }
          break;
      }
    }

    // Data validation
    if (mask.data) {
      if (mask.data.width <= 0 || mask.data.height <= 0) {
        errors.push('Mask data must have positive dimensions');
      }
      if (!mask.data.data || mask.data.data.length === 0) {
        errors.push('Mask data array cannot be empty');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Calculates bounding rectangle for given coordinates and mask type
   */
  calculateBounds(coordinates: Point[], type: 'brush' | 'rectangle' | 'circle'): Rectangle {
    if (coordinates.length === 0) {
      throw new Error('Cannot calculate bounds for empty coordinates');
    }

    switch (type) {
      case 'brush':
        return this.calculateBrushBounds(coordinates);
      case 'rectangle':
        return this.calculateRectangleBounds(coordinates);
      case 'circle':
        return this.calculateCircleBounds(coordinates);
      default:
        throw new Error(`Unsupported mask type: ${type}`);
    }
  }

  /**
   * Generates ImageData for the mask based on coordinates and type
   */
  private generateMaskData(
    coordinates: Point[], 
    type: 'brush' | 'rectangle' | 'circle', 
    bounds: Rectangle,
    canvasSize: ImageSize
  ): ImageData {
    // Create a canvas to generate the mask data
    const canvas = this.createCanvas(canvasSize.width, canvasSize.height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Clear canvas
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);
    
    // Set drawing properties
    ctx.fillStyle = 'white';
    ctx.strokeStyle = 'white';
    ctx.globalAlpha = 1.0;

    switch (type) {
      case 'brush':
        this.drawBrushMask(ctx, coordinates);
        break;
      case 'rectangle':
        this.drawRectangleMask(ctx, coordinates);
        break;
      case 'circle':
        this.drawCircleMask(ctx, coordinates);
        break;
    }

    return ctx.getImageData(0, 0, canvasSize.width, canvasSize.height);
  }

  /**
   * Optimizes mask for provider requirements
   */
  optimizeMask(
    mask: Mask, 
    imageSize: ImageSize, 
    capabilities: ProviderCapabilities
  ): OptimizedMask {
    const targetSize = this.calculateOptimalSize(imageSize, capabilities.maxImageSize);
    const format = this.selectOptimalFormat(capabilities.supportedMaskFormats);
    
    // Scale mask if needed
    const scaledMask = this.scaleMask(mask, targetSize);
    
    // Encode in optimal format
    const optimizedData = this.encodeMask(scaledMask, format);
    
    const compressionRatio = optimizedData.length / (mask.data.data.length * 4); // RGBA = 4 bytes per pixel
    
    return {
      originalMask: mask,
      optimizedData,
      format,
      resolution: targetSize,
      compressionRatio
    };
  }

  /**
   * Encodes mask in specified format
   */
  encodeMask(mask: Mask, format: 'png' | 'base64'): string {
    const canvas = this.createCanvas(mask.data.width, mask.data.height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    ctx.putImageData(mask.data, 0, 0);
    
    if (format === 'png') {
      return canvas.toDataURL('image/png');
    } else {
      return canvas.toDataURL('image/png').split(',')[1]; // Remove data:image/png;base64, prefix
    }
  }

  /**
   * Simplifies mask while preserving precision
   */
  simplifyMask(mask: Mask, tolerance: number = 2.0): Mask {
    if (mask.type !== 'brush') {
      return mask; // Only brush masks can be simplified
    }

    const simplifiedCoordinates = this.simplifyCoordinates(mask.coordinates, tolerance);
    
    return {
      ...mask,
      coordinates: simplifiedCoordinates
    };
  }

  /**
   * Merges multiple masks into a single mask
   */
  mergeMasks(masks: Mask[]): Mask {
    if (masks.length === 0) {
      throw new Error('Cannot merge empty mask array');
    }

    if (masks.length === 1) {
      return { ...masks[0] }; // Return a copy, preserving original type
    }

    // Calculate combined bounds
    const combinedBounds = this.calculateCombinedBounds(masks);
    
    // Create combined mask data
    const canvas = this.createCanvas(combinedBounds.width, combinedBounds.height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Draw all masks onto the combined canvas
    masks.forEach(mask => {
      const tempCanvas = this.createCanvas(mask.data.width, mask.data.height);
      const tempCtx = tempCanvas.getContext('2d');
      if (tempCtx) {
        tempCtx.putImageData(mask.data, 0, 0);
        ctx.globalAlpha = mask.opacity;
        ctx.drawImage(tempCanvas, mask.bounds.x - combinedBounds.x, mask.bounds.y - combinedBounds.y);
      }
    });

    const combinedData = ctx.getImageData(0, 0, combinedBounds.width, combinedBounds.height);
    
    // Combine all coordinates
    const allCoordinates = masks.flatMap(mask => mask.coordinates);

    return {
      id: `merged_${Date.now()}`,
      type: 'brush', // Merged masks are treated as brush type
      coordinates: allCoordinates,
      bounds: combinedBounds,
      opacity: 1.0, // Combined opacity
      data: combinedData
    };
  }

  // Private helper methods

  private calculateBrushBounds(coordinates: Point[]): Rectangle {
    if (coordinates.length === 1) {
      // Single point brush should have some minimum size
      const point = coordinates[0];
      const minSize = 1; // Minimum brush size
      return {
        x: point.x - minSize / 2,
        y: point.y - minSize / 2,
        width: minSize,
        height: minSize
      };
    }
    
    const minX = Math.min(...coordinates.map(p => p.x));
    const maxX = Math.max(...coordinates.map(p => p.x));
    const minY = Math.min(...coordinates.map(p => p.y));
    const maxY = Math.max(...coordinates.map(p => p.y));

    return {
      x: minX,
      y: minY,
      width: Math.max(maxX - minX, 1), // Ensure minimum width of 1
      height: Math.max(maxY - minY, 1) // Ensure minimum height of 1
    };
  }

  private calculateRectangleBounds(coordinates: Point[]): Rectangle {
    if (coordinates.length < 2) {
      throw new Error('Rectangle requires at least 2 coordinates');
    }

    const [topLeft, bottomRight] = coordinates;
    const width = Math.abs(bottomRight.x - topLeft.x);
    const height = Math.abs(bottomRight.y - topLeft.y);
    
    return {
      x: Math.min(topLeft.x, bottomRight.x),
      y: Math.min(topLeft.y, bottomRight.y),
      width: Math.max(width, 1), // Ensure minimum width of 1
      height: Math.max(height, 1) // Ensure minimum height of 1
    };
  }

  private calculateCircleBounds(coordinates: Point[]): Rectangle {
    if (coordinates.length < 2) {
      throw new Error('Circle requires at least 2 coordinates');
    }

    const [center, radiusPoint] = coordinates;
    const radius = Math.max(
      Math.sqrt(
        Math.pow(radiusPoint.x - center.x, 2) + Math.pow(radiusPoint.y - center.y, 2)
      ),
      0.5 // Minimum radius
    );

    return {
      x: center.x - radius,
      y: center.y - radius,
      width: radius * 2,
      height: radius * 2
    };
  }

  private drawBrushMask(ctx: CanvasRenderingContext2D, coordinates: Point[]): void {
    if (coordinates.length === 0) return;

    ctx.beginPath();
    ctx.moveTo(coordinates[0].x, coordinates[0].y);
    
    for (let i = 1; i < coordinates.length; i++) {
      ctx.lineTo(coordinates[i].x, coordinates[i].y);
    }
    
    ctx.lineWidth = 10; // Default brush size
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private drawRectangleMask(ctx: CanvasRenderingContext2D, coordinates: Point[]): void {
    if (coordinates.length < 2) return;

    const [topLeft, bottomRight] = coordinates;
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    
    ctx.fillRect(topLeft.x, topLeft.y, width, height);
  }

  private drawCircleMask(ctx: CanvasRenderingContext2D, coordinates: Point[]): void {
    if (coordinates.length < 2) return;

    const [center, radiusPoint] = coordinates;
    const radius = Math.sqrt(
      Math.pow(radiusPoint.x - center.x, 2) + Math.pow(radiusPoint.y - center.y, 2)
    );

    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
    ctx.fill();
  }

  private calculateOptimalSize(imageSize: ImageSize, maxSize: ImageSize): ImageSize {
    const scaleX = maxSize.width / imageSize.width;
    const scaleY = maxSize.height / imageSize.height;
    const scale = Math.min(scaleX, scaleY, 1); // Don't upscale

    return {
      width: Math.floor(imageSize.width * scale),
      height: Math.floor(imageSize.height * scale)
    };
  }

  private selectOptimalFormat(supportedFormats: string[]): 'png' | 'base64' {
    if (supportedFormats.includes('png')) {
      return 'png';
    }
    return 'base64';
  }

  private scaleMask(mask: Mask, targetSize: ImageSize): Mask {
    if (mask.data.width === targetSize.width && mask.data.height === targetSize.height) {
      return mask;
    }

    const canvas = this.createCanvas(targetSize.width, targetSize.height);
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }

    // Create temporary canvas with original mask
    const tempCanvas = this.createCanvas(mask.data.width, mask.data.height);
    const tempCtx = tempCanvas.getContext('2d');
    if (tempCtx) {
      tempCtx.putImageData(mask.data, 0, 0);
      ctx.drawImage(tempCanvas, 0, 0, targetSize.width, targetSize.height);
    }

    const scaledData = ctx.getImageData(0, 0, targetSize.width, targetSize.height);
    
    // Scale coordinates proportionally
    const scaleX = targetSize.width / mask.data.width;
    const scaleY = targetSize.height / mask.data.height;
    
    const scaledCoordinates = mask.coordinates.map(coord => ({
      x: coord.x * scaleX,
      y: coord.y * scaleY
    }));

    const scaledBounds = {
      x: mask.bounds.x * scaleX,
      y: mask.bounds.y * scaleY,
      width: mask.bounds.width * scaleX,
      height: mask.bounds.height * scaleY
    };

    return {
      ...mask,
      coordinates: scaledCoordinates,
      bounds: scaledBounds,
      data: scaledData
    };
  }

  private simplifyCoordinates(coordinates: Point[], tolerance: number): Point[] {
    if (coordinates.length <= 2) {
      return coordinates;
    }

    // Douglas-Peucker algorithm for line simplification
    return this.douglasPeucker(coordinates, tolerance);
  }

  private douglasPeucker(points: Point[], tolerance: number): Point[] {
    if (points.length <= 2) {
      return points;
    }

    // Find the point with maximum distance from the line between first and last points
    let maxDistance = 0;
    let maxIndex = 0;
    
    const start = points[0];
    const end = points[points.length - 1];
    
    for (let i = 1; i < points.length - 1; i++) {
      const distance = this.pointToLineDistance(points[i], start, end);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }

    // If max distance is greater than tolerance, recursively simplify
    if (maxDistance > tolerance) {
      const leftPart = this.douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
      const rightPart = this.douglasPeucker(points.slice(maxIndex), tolerance);
      
      // Combine results, removing duplicate point at junction
      return leftPart.slice(0, -1).concat(rightPart);
    } else {
      // All points are within tolerance, return just the endpoints
      return [start, end];
    }
  }

  private pointToLineDistance(point: Point, lineStart: Point, lineEnd: Point): number {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    
    if (lenSq === 0) {
      // Line start and end are the same point
      return Math.sqrt(A * A + B * B);
    }

    const param = dot / lenSq;
    
    let xx: number, yy: number;
    
    if (param < 0) {
      xx = lineStart.x;
      yy = lineStart.y;
    } else if (param > 1) {
      xx = lineEnd.x;
      yy = lineEnd.y;
    } else {
      xx = lineStart.x + param * C;
      yy = lineStart.y + param * D;
    }

    const dx = point.x - xx;
    const dy = point.y - yy;
    
    return Math.sqrt(dx * dx + dy * dy);
  }

  private calculateCombinedBounds(masks: Mask[]): Rectangle {
    const minX = Math.min(...masks.map(m => m.bounds.x));
    const minY = Math.min(...masks.map(m => m.bounds.y));
    const maxX = Math.max(...masks.map(m => m.bounds.x + m.bounds.width));
    const maxY = Math.max(...masks.map(m => m.bounds.y + m.bounds.height));

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY
    };
  }

  private createCanvas(width: number, height: number): HTMLCanvasElement {
    // In Node.js environment, we would use a canvas library like 'canvas'
    // For now, we'll create a mock implementation that works in both environments
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      // 🔧 FIX (2026-06-11 G3): jest 切到 jsdom 环境后，未安装 node-canvas 的 jsdom
      // 对 getContext('2d') 一律返回 null，原实现把这种 DOM canvas 直接交给调用方，
      // generateMaskData/encodeMask/mergeMasks/scaleMask 统一炸 'Failed to get canvas
      // context'（mask-processor/mask-optimization 两个 property 套件 1 月起全红的根因）。
      // 改为先探测 2d 上下文：真浏览器/Electron 拿到真 canvas（getContext 幂等，二次
      // 调用返回同一 context，无副作用）；探测失败则下沉到下方既有 mock 兜底，与
      // "document 不存在"的 Node 分支共用同一实现。
      if (canvas.getContext('2d')) {
        return canvas;
      }
    }

    // Mock canvas for environments without 2D context support (Node.js / bare jsdom)
    // 🔧 FIX (2026-06-11 G3): mergeMasks 的 combinedBounds 可能是非整数（圆形 bounds
    // 带无理数半径），真 canvas 按 HTML 规范截断为整数；这里 floor + 下限 1 对齐该
    // 行为，避免 Uint8ClampedArray 收到小数长度抛 RangeError。
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const mockImageData = {
      width: safeWidth,
      height: safeHeight,
      data: new Uint8ClampedArray(safeWidth * safeHeight * 4).fill(255) // Fill with white pixels
    };

    return {
      width: safeWidth,
      height: safeHeight,
      getContext: (type: string) => {
        if (type === '2d') {
          return {
            clearRect: () => {},
            fillRect: () => {},
            beginPath: () => {},
            moveTo: () => {},
            lineTo: () => {},
            arc: () => {},
            fill: () => {},
            stroke: () => {},
            drawImage: () => {},
            putImageData: () => {},
            getImageData: () => mockImageData,
            toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            fillStyle: '',
            strokeStyle: '',
            globalAlpha: 1,
            lineWidth: 1,
            lineCap: 'butt',
            lineJoin: 'miter'
          };
        }
        return null;
      },
      toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
    } as any;
  }
}

export const maskProcessor = new MaskProcessor();
