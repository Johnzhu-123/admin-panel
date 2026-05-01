/**
 * Mask Management Utilities
 * Provides advanced mask operations, validation, and management functions
 */

import { Mask, Point, Rectangle, ValidationResult } from './types';

export interface MaskOperation {
  type: 'create' | 'update' | 'delete' | 'merge' | 'split';
  maskId: string;
  data?: Partial<Mask>;
  timestamp: number;
}

export interface MaskGroup {
  id: string;
  name: string;
  maskIds: string[];
  color: string;
  visible: boolean;
}

export interface MaskStatistics {
  totalMasks: number;
  totalArea: number;
  averageArea: number;
  largestMask: string | null;
  smallestMask: string | null;
  overlappingPairs: string[][];
  typeDistribution: Record<string, number>;
}

export class MaskManager {
  private masks: Map<string, Mask> = new Map();
  private groups: Map<string, MaskGroup> = new Map();
  private history: MaskOperation[] = [];
  private maxHistorySize = 50;

  constructor(initialMasks: Mask[] = []) {
    initialMasks.forEach(mask => this.masks.set(mask.id, mask));
  }

  // Basic mask operations
  addMask(mask: Mask): void {
    this.masks.set(mask.id, mask);
    this.recordOperation({
      type: 'create',
      maskId: mask.id,
      data: mask,
      timestamp: Date.now()
    });
  }

  updateMask(maskId: string, updates: Partial<Mask>): boolean {
    const mask = this.masks.get(maskId);
    if (!mask) return false;

    const updatedMask = { ...mask, ...updates };
    this.masks.set(maskId, updatedMask);
    this.recordOperation({
      type: 'update',
      maskId,
      data: updates,
      timestamp: Date.now()
    });
    return true;
  }

  deleteMask(maskId: string): boolean {
    const deleted = this.masks.delete(maskId);
    if (deleted) {
      this.recordOperation({
        type: 'delete',
        maskId,
        timestamp: Date.now()
      });
      // Remove from groups
      this.groups.forEach(group => {
        group.maskIds = group.maskIds.filter(id => id !== maskId);
      });
    }
    return deleted;
  }

  getMask(maskId: string): Mask | undefined {
    return this.masks.get(maskId);
  }

  getAllMasks(): Mask[] {
    return Array.from(this.masks.values());
  }

  // Mask validation
  validateMask(mask: Mask): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check required fields
    if (!mask.id) errors.push('Mask ID is required');
    if (!mask.type) errors.push('Mask type is required');
    if (!mask.coordinates || mask.coordinates.length === 0) {
      errors.push('Mask coordinates are required');
    }

    // Validate coordinates
    if (mask.coordinates) {
      const invalidCoords = mask.coordinates.some(coord => 
        typeof coord.x !== 'number' || typeof coord.y !== 'number' ||
        isNaN(coord.x) || isNaN(coord.y)
      );
      if (invalidCoords) {
        errors.push('Invalid coordinates detected');
      }
    }

    // Validate bounds
    if (mask.bounds) {
      if (mask.bounds.width < 0 || mask.bounds.height < 0) {
        errors.push('Mask bounds cannot have negative dimensions');
      }
      if (mask.bounds.width === 0 && mask.bounds.height === 0) {
        warnings.push('Mask has zero area');
      }
    }

    // Validate opacity
    if (mask.opacity < 0 || mask.opacity > 1) {
      errors.push('Mask opacity must be between 0 and 1');
    }

    // Type-specific validation
    switch (mask.type) {
      case 'rectangle':
        if (mask.coordinates.length !== 2) {
          errors.push('Rectangle mask must have exactly 2 coordinates');
        }
        break;
      case 'circle':
        if (mask.coordinates.length !== 2) {
          errors.push('Circle mask must have exactly 2 coordinates');
        }
        break;
      case 'brush':
        if (mask.coordinates.length < 2) {
          warnings.push('Brush mask with less than 2 points may not be visible');
        }
        break;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  // Mask analysis and statistics
  calculateStatistics(): MaskStatistics {
    const masks = this.getAllMasks();
    const areas = masks.map(mask => mask.bounds.width * mask.bounds.height);
    const totalArea = areas.reduce((sum, area) => sum + area, 0);

    const typeDistribution: Record<string, number> = {};
    masks.forEach(mask => {
      typeDistribution[mask.type] = (typeDistribution[mask.type] || 0) + 1;
    });

    let largestMask: string | null = null;
    let smallestMask: string | null = null;
    let maxArea = -1;
    let minArea = Infinity;

    masks.forEach((mask, index) => {
      const area = areas[index];
      if (area > maxArea) {
        maxArea = area;
        largestMask = mask.id;
      }
      if (area < minArea) {
        minArea = area;
        smallestMask = mask.id;
      }
    });

    return {
      totalMasks: masks.length,
      totalArea,
      averageArea: masks.length > 0 ? totalArea / masks.length : 0,
      largestMask,
      smallestMask,
      overlappingPairs: this.findOverlappingMasks(),
      typeDistribution
    };
  }

  // Find overlapping masks
  findOverlappingMasks(): string[][] {
    const masks = this.getAllMasks();
    const overlapping: string[][] = [];

    for (let i = 0; i < masks.length; i++) {
      for (let j = i + 1; j < masks.length; j++) {
        if (this.masksOverlap(masks[i], masks[j])) {
          overlapping.push([masks[i].id, masks[j].id]);
        }
      }
    }

    return overlapping;
  }

  private masksOverlap(mask1: Mask, mask2: Mask): boolean {
    const bounds1 = mask1.bounds;
    const bounds2 = mask2.bounds;

    return !(
      bounds1.x + bounds1.width < bounds2.x ||
      bounds2.x + bounds2.width < bounds1.x ||
      bounds1.y + bounds1.height < bounds2.y ||
      bounds2.y + bounds2.height < bounds1.y
    );
  }

  // Mask merging
  mergeMasks(maskIds: string[], newMaskId: string): Mask | null {
    const masksToMerge = maskIds.map(id => this.masks.get(id)).filter(Boolean) as Mask[];
    if (masksToMerge.length < 2) return null;

    // Calculate combined bounds
    const allCoordinates: Point[] = [];
    masksToMerge.forEach(mask => {
      allCoordinates.push(...mask.coordinates);
    });

    const bounds = this.calculateBounds(allCoordinates);
    
    // Create merged mask
    const mergedMask: Mask = {
      id: newMaskId,
      type: 'brush', // Merged masks become brush type
      coordinates: allCoordinates,
      bounds,
      opacity: Math.max(...masksToMerge.map(m => m.opacity)),
      data: this.combineImageData(masksToMerge.map(m => m.data))
    };

    // Add merged mask and remove originals
    this.addMask(mergedMask);
    maskIds.forEach(id => this.deleteMask(id));

    this.recordOperation({
      type: 'merge',
      maskId: newMaskId,
      data: { originalMasks: maskIds },
      timestamp: Date.now()
    });

    return mergedMask;
  }

  // Group management
  createGroup(name: string, maskIds: string[], color: string = '#000000'): string {
    const groupId = `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const group: MaskGroup = {
      id: groupId,
      name,
      maskIds: maskIds.filter(id => this.masks.has(id)),
      color,
      visible: true
    };
    this.groups.set(groupId, group);
    return groupId;
  }

  updateGroup(groupId: string, updates: Partial<MaskGroup>): boolean {
    const group = this.groups.get(groupId);
    if (!group) return false;

    this.groups.set(groupId, { ...group, ...updates });
    return true;
  }

  deleteGroup(groupId: string): boolean {
    return this.groups.delete(groupId);
  }

  getGroup(groupId: string): MaskGroup | undefined {
    return this.groups.get(groupId);
  }

  getAllGroups(): MaskGroup[] {
    return Array.from(this.groups.values());
  }

  // Utility functions
  private calculateBounds(coordinates: Point[]): Rectangle {
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
  }

  private combineImageData(imageDataArray: ImageData[]): ImageData {
    if (imageDataArray.length === 0) {
      return new ImageData(1, 1);
    }

    // For simplicity, return the first ImageData
    // In a real implementation, you would combine the pixel data
    return imageDataArray[0];
  }

  private recordOperation(operation: MaskOperation): void {
    this.history.push(operation);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  // History and undo/redo
  getHistory(): MaskOperation[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  // Export/Import
  exportMasks(): string {
    const data = {
      masks: Array.from(this.masks.entries()),
      groups: Array.from(this.groups.entries()),
      timestamp: Date.now()
    };
    return JSON.stringify(data);
  }

  importMasks(jsonData: string): boolean {
    try {
      const data = JSON.parse(jsonData);
      
      // Clear existing data
      this.masks.clear();
      this.groups.clear();
      
      // Import masks
      if (data.masks) {
        data.masks.forEach(([id, mask]: [string, Mask]) => {
          this.masks.set(id, mask);
        });
      }
      
      // Import groups
      if (data.groups) {
        data.groups.forEach(([id, group]: [string, MaskGroup]) => {
          this.groups.set(id, group);
        });
      }
      
      return true;
    } catch (error) {
      console.error('Failed to import masks:', error);
      return false;
    }
  }

  // Search and filter
  searchMasks(query: string): Mask[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllMasks().filter(mask => 
      mask.id.toLowerCase().includes(lowerQuery) ||
      mask.type.toLowerCase().includes(lowerQuery)
    );
  }

  filterMasksByType(type: Mask['type']): Mask[] {
    return this.getAllMasks().filter(mask => mask.type === type);
  }

  filterMasksByArea(minArea: number, maxArea: number): Mask[] {
    return this.getAllMasks().filter(mask => {
      const area = mask.bounds.width * mask.bounds.height;
      return area >= minArea && area <= maxArea;
    });
  }

  // Mask optimization
  optimizeMask(maskId: string, tolerance: number = 1): boolean {
    const mask = this.masks.get(maskId);
    if (!mask || mask.type !== 'brush') return false;

    // Simplify brush coordinates using Douglas-Peucker algorithm
    const simplified = this.simplifyPath(mask.coordinates, tolerance);
    
    if (simplified.length < mask.coordinates.length) {
      this.updateMask(maskId, {
        coordinates: simplified,
        bounds: this.calculateBounds(simplified)
      });
      return true;
    }
    
    return false;
  }

  private simplifyPath(points: Point[], tolerance: number): Point[] {
    if (points.length <= 2) return points;

    // Simple implementation of Douglas-Peucker algorithm
    const simplified = [points[0]];
    let lastIndex = 0;

    for (let i = 1; i < points.length; i++) {
      const distance = this.pointToLineDistance(
        points[i],
        points[lastIndex],
        points[points.length - 1]
      );

      if (distance > tolerance) {
        simplified.push(points[i]);
        lastIndex = i;
      }
    }

    simplified.push(points[points.length - 1]);
    return simplified;
  }

  private pointToLineDistance(point: Point, lineStart: Point, lineEnd: Point): number {
    const A = point.x - lineStart.x;
    const B = point.y - lineStart.y;
    const C = lineEnd.x - lineStart.x;
    const D = lineEnd.y - lineStart.y;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    
    if (lenSq === 0) return Math.sqrt(A * A + B * B);

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
}

export default MaskManager;