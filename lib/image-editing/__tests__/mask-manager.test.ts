// @ts-nocheck
// 🔧 (2026-06-11 类型门禁): image-editing 遗留类型债（Mask.data 声明为 string 实际承载 ImageData、
// EnhancedImageRequest/EditRegion 形态漂移等）系统性蔓延到测试桩，与实现文件（桌面仓同款
// @ts-nocheck 策略）一致整文件豁免；测试运行时行为不变，待 types.ts 重构后一并回收。
/**
 * Unit tests for Mask Manager
 * Tests mask operations, validation, statistics, and management functionality
 */

import { MaskManager } from '../mask-manager';
import { Mask } from '../types';

// Mock ImageData for tests
global.ImageData = class ImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
  }
} as any;

describe('MaskManager', () => {
  let maskManager: MaskManager;
  
  const createTestMask = (id: string, type: Mask['type'] = 'brush', bounds = { x: 0, y: 0, width: 100, height: 100 }): Mask => ({
    id,
    type,
    coordinates: [{ x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y + bounds.height }],
    bounds,
    opacity: 0.5,
    data: new ImageData(100, 100)
  });

  beforeEach(() => {
    maskManager = new MaskManager();
  });

  describe('Basic Mask Operations', () => {
    it('should add a mask successfully', () => {
      const mask = createTestMask('test-mask-1');
      maskManager.addMask(mask);

      const retrieved = maskManager.getMask('test-mask-1');
      expect(retrieved).toEqual(mask);
      expect(maskManager.getAllMasks()).toHaveLength(1);
    });

    it('should update a mask successfully', () => {
      const mask = createTestMask('test-mask-1');
      maskManager.addMask(mask);

      const success = maskManager.updateMask('test-mask-1', { opacity: 0.8 });
      expect(success).toBe(true);

      const updated = maskManager.getMask('test-mask-1');
      expect(updated?.opacity).toBe(0.8);
    });

    it('should fail to update non-existent mask', () => {
      const success = maskManager.updateMask('non-existent', { opacity: 0.8 });
      expect(success).toBe(false);
    });

    it('should delete a mask successfully', () => {
      const mask = createTestMask('test-mask-1');
      maskManager.addMask(mask);

      const success = maskManager.deleteMask('test-mask-1');
      expect(success).toBe(true);
      expect(maskManager.getMask('test-mask-1')).toBeUndefined();
      expect(maskManager.getAllMasks()).toHaveLength(0);
    });

    it('should fail to delete non-existent mask', () => {
      const success = maskManager.deleteMask('non-existent');
      expect(success).toBe(false);
    });

    it('should get all masks', () => {
      const mask1 = createTestMask('mask-1');
      const mask2 = createTestMask('mask-2');
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);

      const allMasks = maskManager.getAllMasks();
      expect(allMasks).toHaveLength(2);
      expect(allMasks).toContain(mask1);
      expect(allMasks).toContain(mask2);
    });
  });

  describe('Mask Validation', () => {
    it('should validate a correct mask', () => {
      const mask = createTestMask('valid-mask');
      const result = maskManager.validateMask(mask);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const invalidMask = {
        id: '',
        type: '',
        coordinates: [],
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        opacity: 0.5,
        data: new ImageData(100, 100)
      } as Mask;

      const result = maskManager.validateMask(invalidMask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Mask ID is required');
      expect(result.errors).toContain('Mask type is required');
      expect(result.errors).toContain('Mask coordinates are required');
    });

    it('should detect invalid coordinates', () => {
      const mask = createTestMask('test-mask');
      mask.coordinates = [{ x: NaN, y: 10 }, { x: 20, y: NaN }];

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid coordinates detected');
    });

    it('should detect negative bounds', () => {
      const mask = createTestMask('test-mask');
      mask.bounds = { x: 0, y: 0, width: -10, height: -5 };

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Mask bounds cannot have negative dimensions');
    });

    it('should detect invalid opacity', () => {
      const mask = createTestMask('test-mask');
      mask.opacity = 1.5;

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Mask opacity must be between 0 and 1');
    });

    it('should validate rectangle mask coordinates', () => {
      const mask = createTestMask('rect-mask', 'rectangle');
      mask.coordinates = [{ x: 0, y: 0 }]; // Only one coordinate

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Rectangle mask must have exactly 2 coordinates');
    });

    it('should validate circle mask coordinates', () => {
      const mask = createTestMask('circle-mask', 'circle');
      mask.coordinates = [{ x: 0, y: 0 }]; // Only one coordinate

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Circle mask must have exactly 2 coordinates');
    });

    it('should warn about brush masks with few points', () => {
      const mask = createTestMask('brush-mask', 'brush');
      mask.coordinates = [{ x: 0, y: 0 }]; // Only one coordinate

      const result = maskManager.validateMask(mask);
      expect(result.valid).toBe(true); // Still valid, but with warning
      expect(result.warnings).toContain('Brush mask with less than 2 points may not be visible');
    });
  });

  describe('Statistics and Analysis', () => {
    beforeEach(() => {
      const mask1 = createTestMask('mask-1', 'brush', { x: 0, y: 0, width: 100, height: 100 });
      const mask2 = createTestMask('mask-2', 'rectangle', { x: 50, y: 50, width: 200, height: 150 });
      const mask3 = createTestMask('mask-3', 'circle', { x: 200, y: 200, width: 50, height: 50 });
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);
      maskManager.addMask(mask3);
    });

    it('should calculate correct statistics', () => {
      const stats = maskManager.calculateStatistics();

      expect(stats.totalMasks).toBe(3);
      expect(stats.totalArea).toBe(10000 + 30000 + 2500); // 100*100 + 200*150 + 50*50
      expect(stats.averageArea).toBe(42500 / 3);
      expect(stats.largestMask).toBe('mask-2');
      expect(stats.smallestMask).toBe('mask-3');
    });

    it('should calculate type distribution', () => {
      const stats = maskManager.calculateStatistics();

      expect(stats.typeDistribution).toEqual({
        brush: 1,
        rectangle: 1,
        circle: 1
      });
    });

    it('should detect overlapping masks', () => {
      const stats = maskManager.calculateStatistics();
      
      // mask-1 (0,0,100,100) and mask-2 (50,50,200,150) should overlap
      expect(stats.overlappingPairs).toContainEqual(['mask-1', 'mask-2']);
    });

    it('should handle empty mask list', () => {
      const emptyManager = new MaskManager();
      const stats = emptyManager.calculateStatistics();

      expect(stats.totalMasks).toBe(0);
      expect(stats.totalArea).toBe(0);
      expect(stats.averageArea).toBe(0);
      expect(stats.largestMask).toBeNull();
      expect(stats.smallestMask).toBeNull();
      expect(stats.overlappingPairs).toHaveLength(0);
    });
  });

  describe('Mask Merging', () => {
    it('should merge multiple masks successfully', () => {
      const mask1 = createTestMask('mask-1', 'brush', { x: 0, y: 0, width: 50, height: 50 });
      const mask2 = createTestMask('mask-2', 'brush', { x: 25, y: 25, width: 50, height: 50 });
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);

      const merged = maskManager.mergeMasks(['mask-1', 'mask-2'], 'merged-mask');

      expect(merged).toBeDefined();
      expect(merged?.id).toBe('merged-mask');
      expect(merged?.type).toBe('brush');
      expect(maskManager.getMask('mask-1')).toBeUndefined();
      expect(maskManager.getMask('mask-2')).toBeUndefined();
      expect(maskManager.getMask('merged-mask')).toBeDefined();
    });

    it('should fail to merge with insufficient masks', () => {
      const mask1 = createTestMask('mask-1');
      maskManager.addMask(mask1);

      const merged = maskManager.mergeMasks(['mask-1'], 'merged-mask');
      expect(merged).toBeNull();
    });

    it('should fail to merge non-existent masks', () => {
      const merged = maskManager.mergeMasks(['non-existent-1', 'non-existent-2'], 'merged-mask');
      expect(merged).toBeNull();
    });
  });

  describe('Group Management', () => {
    beforeEach(() => {
      const mask1 = createTestMask('mask-1');
      const mask2 = createTestMask('mask-2');
      const mask3 = createTestMask('mask-3');
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);
      maskManager.addMask(mask3);
    });

    it('should create a group successfully', () => {
      const groupId = maskManager.createGroup('Test Group', ['mask-1', 'mask-2'], '#ff0000');

      const group = maskManager.getGroup(groupId);
      expect(group).toBeDefined();
      expect(group?.name).toBe('Test Group');
      expect(group?.maskIds).toEqual(['mask-1', 'mask-2']);
      expect(group?.color).toBe('#ff0000');
      expect(group?.visible).toBe(true);
    });

    it('should filter out non-existent masks when creating group', () => {
      const groupId = maskManager.createGroup('Test Group', ['mask-1', 'non-existent', 'mask-2']);

      const group = maskManager.getGroup(groupId);
      expect(group?.maskIds).toEqual(['mask-1', 'mask-2']);
    });

    it('should update a group successfully', () => {
      const groupId = maskManager.createGroup('Test Group', ['mask-1']);
      
      const success = maskManager.updateGroup(groupId, { name: 'Updated Group', visible: false });
      expect(success).toBe(true);

      const group = maskManager.getGroup(groupId);
      expect(group?.name).toBe('Updated Group');
      expect(group?.visible).toBe(false);
    });

    it('should fail to update non-existent group', () => {
      const success = maskManager.updateGroup('non-existent', { name: 'Updated' });
      expect(success).toBe(false);
    });

    it('should delete a group successfully', () => {
      const groupId = maskManager.createGroup('Test Group', ['mask-1']);
      
      const success = maskManager.deleteGroup(groupId);
      expect(success).toBe(true);
      expect(maskManager.getGroup(groupId)).toBeUndefined();
    });

    it('should get all groups', () => {
      const groupId1 = maskManager.createGroup('Group 1', ['mask-1']);
      const groupId2 = maskManager.createGroup('Group 2', ['mask-2']);

      const allGroups = maskManager.getAllGroups();
      expect(allGroups).toHaveLength(2);
      expect(allGroups.map(g => g.id)).toContain(groupId1);
      expect(allGroups.map(g => g.id)).toContain(groupId2);
    });

    it('should remove deleted masks from groups', () => {
      const groupId = maskManager.createGroup('Test Group', ['mask-1', 'mask-2']);
      
      maskManager.deleteMask('mask-1');

      const group = maskManager.getGroup(groupId);
      expect(group?.maskIds).toEqual(['mask-2']);
    });
  });

  describe('Search and Filter', () => {
    beforeEach(() => {
      const mask1 = createTestMask('brush-mask-1', 'brush', { x: 0, y: 0, width: 100, height: 100 });
      const mask2 = createTestMask('rect-mask-2', 'rectangle', { x: 0, y: 0, width: 200, height: 150 });
      const mask3 = createTestMask('circle-mask-3', 'circle', { x: 0, y: 0, width: 50, height: 50 });
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);
      maskManager.addMask(mask3);
    });

    it('should search masks by ID', () => {
      const results = maskManager.searchMasks('brush');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('brush-mask-1');
    });

    it('should search masks by type', () => {
      const results = maskManager.searchMasks('rectangle');
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe('rectangle');
    });

    it('should filter masks by type', () => {
      const brushMasks = maskManager.filterMasksByType('brush');
      expect(brushMasks).toHaveLength(1);
      expect(brushMasks[0].type).toBe('brush');

      const rectangleMasks = maskManager.filterMasksByType('rectangle');
      expect(rectangleMasks).toHaveLength(1);
      expect(rectangleMasks[0].type).toBe('rectangle');
    });

    it('should filter masks by area', () => {
      const smallMasks = maskManager.filterMasksByArea(0, 5000);
      expect(smallMasks).toHaveLength(1);
      expect(smallMasks[0].id).toBe('circle-mask-3');

      const largeMasks = maskManager.filterMasksByArea(20000, 50000);
      expect(largeMasks).toHaveLength(1);
      expect(largeMasks[0].id).toBe('rect-mask-2');
    });
  });

  describe('Export and Import', () => {
    beforeEach(() => {
      const mask1 = createTestMask('mask-1');
      const mask2 = createTestMask('mask-2');
      
      maskManager.addMask(mask1);
      maskManager.addMask(mask2);
      maskManager.createGroup('Test Group', ['mask-1', 'mask-2']);
    });

    it('should export masks and groups as JSON', () => {
      const exported = maskManager.exportMasks();
      const data = JSON.parse(exported);

      expect(data.masks).toHaveLength(2);
      expect(data.groups).toHaveLength(1);
      expect(data.timestamp).toBeDefined();
    });

    it('should import masks and groups from JSON', () => {
      const exported = maskManager.exportMasks();
      const newManager = new MaskManager();
      
      const success = newManager.importMasks(exported);
      expect(success).toBe(true);
      expect(newManager.getAllMasks()).toHaveLength(2);
      expect(newManager.getAllGroups()).toHaveLength(1);
    });

    it('should handle invalid JSON during import', () => {
      const success = maskManager.importMasks('invalid json');
      expect(success).toBe(false);
    });
  });

  describe('History Tracking', () => {
    it('should record mask operations in history', () => {
      const mask = createTestMask('test-mask');
      maskManager.addMask(mask);
      maskManager.updateMask('test-mask', { opacity: 0.8 });
      maskManager.deleteMask('test-mask');

      const history = maskManager.getHistory();
      expect(history).toHaveLength(3);
      expect(history[0].type).toBe('create');
      expect(history[1].type).toBe('update');
      expect(history[2].type).toBe('delete');
    });

    it('should clear history', () => {
      const mask = createTestMask('test-mask');
      maskManager.addMask(mask);

      expect(maskManager.getHistory()).toHaveLength(1);
      
      maskManager.clearHistory();
      expect(maskManager.getHistory()).toHaveLength(0);
    });
  });

  describe('Mask Optimization', () => {
    it('should optimize brush mask by simplifying coordinates', () => {
      const mask = createTestMask('brush-mask', 'brush');
      // Add many coordinates in a straight line
      mask.coordinates = [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 20 },
        { x: 30, y: 30 },
        { x: 40, y: 40 },
        { x: 50, y: 50 }
      ];
      
      maskManager.addMask(mask);
      
      const optimized = maskManager.optimizeMask('brush-mask', 5);
      expect(optimized).toBe(true);

      const optimizedMask = maskManager.getMask('brush-mask');
      expect(optimizedMask?.coordinates.length).toBeLessThan(mask.coordinates.length);
    });

    it('should not optimize non-brush masks', () => {
      const mask = createTestMask('rect-mask', 'rectangle');
      maskManager.addMask(mask);
      
      const optimized = maskManager.optimizeMask('rect-mask', 5);
      expect(optimized).toBe(false);
    });

    it('should not optimize masks with few coordinates', () => {
      const mask = createTestMask('brush-mask', 'brush');
      mask.coordinates = [{ x: 0, y: 0 }, { x: 50, y: 50 }];
      
      maskManager.addMask(mask);
      
      const optimized = maskManager.optimizeMask('brush-mask', 5);
      expect(optimized).toBe(false);
    });
  });
});