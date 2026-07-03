'use client';
/* eslint-disable @next/next/no-img-element */

import React, { useState, useRef, useEffect } from 'react';
import { Mask } from './types';

/**
 * Enhanced mask visualization and management component
 * Provides advanced visualization features, before/after comparison, and mask management
 */

interface MaskVisualizationProps {
  masks: Mask[];
  originalImage?: string;
  editedImage?: string;
  onMaskSelect?: (maskId: string) => void;
  onMaskVisibilityToggle?: (maskId: string, visible: boolean) => void;
  onMaskOpacityChange?: (maskId: string, opacity: number) => void;
  onMaskColorChange?: (maskId: string, color: string) => void;
  onMaskDelete?: (maskId: string) => void;
  className?: string;
}

interface MaskDisplaySettings {
  visible: boolean;
  opacity: number;
  color: string;
  selected: boolean;
}

type MaskSettings = Record<string, MaskDisplaySettings>;

const DEFAULT_MASK_COLORS = [
  '#ff0000', '#00ff00', '#0000ff', '#ffff00',
  '#ff00ff', '#00ffff', '#ff8000', '#8000ff'
];

export const MaskVisualization: React.FC<MaskVisualizationProps> = ({
  masks,
  originalImage,
  editedImage,
  onMaskSelect,
  onMaskVisibilityToggle,
  onMaskOpacityChange,
  onMaskColorChange,
  onMaskDelete,
  className = ''
}) => {
  const [maskSettings, setMaskSettings] = useState<MaskSettings>({});
  const [showComparison, setShowComparison] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<'side-by-side' | 'overlay' | 'slider'>('side-by-side');
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);

  // Initialize mask settings when masks change
  useEffect(() => {
    setMaskSettings((prev) => {
      const nextSettings: MaskSettings = {};
      masks.forEach((mask, index) => {
        nextSettings[mask.id] = prev[mask.id] || {
          visible: true,
          opacity: mask.opacity || 0.5,
          color: DEFAULT_MASK_COLORS[index % DEFAULT_MASK_COLORS.length],
          selected: false
        };
      });
      return nextSettings;
    });
  }, [masks]);

  const handleMaskSelect = (maskId: string) => {
    setSelectedMaskId(maskId);
    setMaskSettings(prev => {
      const updated = { ...prev };
      Object.keys(updated).forEach(id => {
        updated[id] = { ...updated[id], selected: id === maskId };
      });
      return updated;
    });
    if (onMaskSelect) {
      onMaskSelect(maskId);
    }
  };

  const handleVisibilityToggle = (maskId: string) => {
    const newVisible = !maskSettings[maskId]?.visible;
    setMaskSettings(prev => ({
      ...prev,
      [maskId]: { ...prev[maskId], visible: newVisible }
    }));
    if (onMaskVisibilityToggle) {
      onMaskVisibilityToggle(maskId, newVisible);
    }
  };

  const handleOpacityChange = (maskId: string, opacity: number) => {
    setMaskSettings(prev => ({
      ...prev,
      [maskId]: { ...prev[maskId], opacity }
    }));
    if (onMaskOpacityChange) {
      onMaskOpacityChange(maskId, opacity);
    }
  };

  const handleColorChange = (maskId: string, color: string) => {
    setMaskSettings(prev => ({
      ...prev,
      [maskId]: { ...prev[maskId], color }
    }));
    if (onMaskColorChange) {
      onMaskColorChange(maskId, color);
    }
  };

  const handleDelete = (maskId: string) => {
    setMaskSettings(prev => {
      const updated = { ...prev };
      delete updated[maskId];
      return updated;
    });
    if (selectedMaskId === maskId) {
      setSelectedMaskId(null);
    }
    if (onMaskDelete) {
      onMaskDelete(maskId);
    }
  };

  const getMaskStats = (mask: Mask) => {
    const area = mask.bounds.width * mask.bounds.height;
    const perimeter = 2 * (mask.bounds.width + mask.bounds.height);
    return { area, perimeter };
  };

  const formatMaskType = (type: string) => {
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  return (
    <div className={`mask-visualization ${className}`}>
      {/* Mask List and Controls */}
      <div className="mask-controls mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">
            Masks ({masks.length})
          </h3>
          {originalImage && editedImage && (
            <button
              onClick={() => setShowComparison(!showComparison)}
              className="px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
            >
              {showComparison ? 'Hide' : 'Show'} Comparison
            </button>
          )}
        </div>

        {/* Mask List */}
        <div className="space-y-3">
          {masks.map((mask, index) => {
            const settings = maskSettings[mask.id];
            const stats = getMaskStats(mask);
            
            return (
              <div
                key={mask.id}
                className={`mask-item p-3 border rounded-lg cursor-pointer transition-all ${
                  settings?.selected 
                    ? 'border-blue-500 bg-blue-50' 
                    : 'border-gray-300 hover:border-gray-400'
                }`}
                onClick={() => handleMaskSelect(mask.id)}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded border"
                      style={{ backgroundColor: settings?.color || DEFAULT_MASK_COLORS[index % DEFAULT_MASK_COLORS.length] }}
                    />
                    <span className="font-medium">
                      {formatMaskType(mask.type)} Mask {index + 1}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleVisibilityToggle(mask.id);
                      }}
                      className={`px-2 py-1 text-xs rounded ${
                        settings?.visible 
                          ? 'bg-green-500 text-white' 
                          : 'bg-gray-300 text-gray-700'
                      }`}
                    >
                      {settings?.visible ? 'Visible' : 'Hidden'}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(mask.id);
                      }}
                      className="px-2 py-1 text-xs bg-red-500 text-white rounded hover:bg-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Mask Details */}
                <div className="text-sm text-gray-600 mb-2">
                  <div>Position: ({Math.round(mask.bounds.x)}, {Math.round(mask.bounds.y)})</div>
                  <div>Size: {Math.round(mask.bounds.width)} × {Math.round(mask.bounds.height)}</div>
                  <div>Area: {Math.round(stats.area)} px²</div>
                </div>

                {/* Mask Controls */}
                {settings?.selected && (
                  <div className="mask-controls-expanded space-y-2 pt-2 border-t">
                    {/* Opacity Control */}
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium w-16">Opacity:</label>
                      <input
                        type="range"
                        min="0.1"
                        max="1"
                        step="0.1"
                        value={settings.opacity}
                        onChange={(e) => handleOpacityChange(mask.id, parseFloat(e.target.value))}
                        className="flex-1"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="text-xs w-8">{Math.round(settings.opacity * 100)}%</span>
                    </div>

                    {/* Color Control */}
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-medium w-16">Color:</label>
                      <input
                        type="color"
                        value={settings.color}
                        onChange={(e) => handleColorChange(mask.id, e.target.value)}
                        className="w-8 h-6 rounded border"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="flex gap-1">
                        {DEFAULT_MASK_COLORS.map(color => (
                          <button
                            key={color}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleColorChange(mask.id, color);
                            }}
                            className="w-4 h-4 rounded border border-gray-300"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {masks.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No masks created yet. Use the canvas tools to create masks.
          </div>
        )}
      </div>

      {/* Before/After Comparison */}
      {showComparison && originalImage && editedImage && (
        <div className="comparison-section">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Before/After Comparison</h3>
            <div className="flex gap-2">
              <button
                onClick={() => setComparisonMode('side-by-side')}
                className={`px-3 py-1 text-sm rounded ${
                  comparisonMode === 'side-by-side' 
                    ? 'bg-blue-500 text-white' 
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                Side by Side
              </button>
              <button
                onClick={() => setComparisonMode('overlay')}
                className={`px-3 py-1 text-sm rounded ${
                  comparisonMode === 'overlay' 
                    ? 'bg-blue-500 text-white' 
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                Overlay
              </button>
              <button
                onClick={() => setComparisonMode('slider')}
                className={`px-3 py-1 text-sm rounded ${
                  comparisonMode === 'slider' 
                    ? 'bg-blue-500 text-white' 
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                Slider
              </button>
            </div>
          </div>

          <div className="comparison-container">
            {comparisonMode === 'side-by-side' && (
              <div className="flex gap-4">
                <div className="flex-1">
                  <h4 className="text-sm font-medium mb-2">Before</h4>
                  <img
                    src={originalImage}
                    alt="Original"
                    className="w-full border rounded"
                  />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-medium mb-2">After</h4>
                  <img
                    src={editedImage}
                    alt="Edited"
                    className="w-full border rounded"
                  />
                </div>
              </div>
            )}

            {comparisonMode === 'overlay' && (
              <div className="relative">
                <img
                  src={originalImage}
                  alt="Original"
                  className="w-full border rounded"
                />
                <img
                  src={editedImage}
                  alt="Edited"
                  className="absolute top-0 left-0 w-full border rounded opacity-50 hover:opacity-100 transition-opacity"
                />
                <div className="absolute top-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-xs">
                  Hover to see edited version
                </div>
              </div>
            )}

            {comparisonMode === 'slider' && (
              <SliderComparison
                beforeImage={originalImage}
                afterImage={editedImage}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Slider comparison component
interface SliderComparisonProps {
  beforeImage: string;
  afterImage: string;
}

const SliderComparison: React.FC<SliderComparisonProps> = ({
  beforeImage,
  afterImage
}) => {
  const [sliderPosition, setSliderPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderPosition(parseInt(e.target.value));
  };

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative overflow-hidden border rounded">
        <img
          src={beforeImage}
          alt="Before"
          className="w-full block"
        />
        <div
          className="absolute top-0 left-0 h-full overflow-hidden"
          style={{ width: `${sliderPosition}%` }}
        >
          <img
            src={afterImage}
            alt="After"
            className="w-full h-full object-cover"
            style={{ width: `${100 * 100 / sliderPosition}%` }}
          />
        </div>
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg"
          style={{ left: `${sliderPosition}%` }}
        />
      </div>
      <input
        type="range"
        min="0"
        max="100"
        value={sliderPosition}
        onChange={handleSliderChange}
        className="w-full mt-2"
      />
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>Before</span>
        <span>After</span>
      </div>
    </div>
  );
};

export default MaskVisualization;
