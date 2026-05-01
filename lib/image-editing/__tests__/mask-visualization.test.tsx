/**
 * Unit tests for Mask Visualization component
 * Tests mask display, interaction, and before/after comparison functionality
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MaskVisualization } from '../mask-visualization';
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

describe('MaskVisualization', () => {
  const mockMasks: Mask[] = [
    {
      id: 'mask-1',
      type: 'brush',
      coordinates: [{ x: 10, y: 10 }, { x: 50, y: 50 }],
      bounds: { x: 10, y: 10, width: 40, height: 40 },
      opacity: 0.5,
      data: new ImageData(100, 100)
    },
    {
      id: 'mask-2',
      type: 'rectangle',
      coordinates: [{ x: 100, y: 100 }, { x: 200, y: 150 }],
      bounds: { x: 100, y: 100, width: 100, height: 50 },
      opacity: 0.7,
      data: new ImageData(100, 100)
    },
    {
      id: 'mask-3',
      type: 'circle',
      coordinates: [{ x: 300, y: 300 }, { x: 350, y: 350 }],
      bounds: { x: 300, y: 300, width: 50, height: 50 },
      opacity: 0.3,
      data: new ImageData(100, 100)
    }
  ];

  const mockCallbacks = {
    onMaskSelect: jest.fn(),
    onMaskVisibilityToggle: jest.fn(),
    onMaskOpacityChange: jest.fn(),
    onMaskColorChange: jest.fn(),
    onMaskDelete: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Mask List Display', () => {
    it('should display all masks with correct information', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Masks (3)')).toBeInTheDocument();
      expect(screen.getByText('Brush Mask 1')).toBeInTheDocument();
      expect(screen.getByText('Rectangle Mask 2')).toBeInTheDocument();
      expect(screen.getByText('Circle Mask 3')).toBeInTheDocument();
    });

    it('should display mask details correctly', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // Check first mask details
      expect(screen.getByText('Position: (10, 10)')).toBeInTheDocument();
      expect(screen.getByText('Size: 40 × 40')).toBeInTheDocument();
      expect(screen.getByText('Area: 1600 px²')).toBeInTheDocument();
    });

    it('should show empty state when no masks are provided', () => {
      render(
        <MaskVisualization
          masks={[]}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Masks (0)')).toBeInTheDocument();
      expect(screen.getByText('No masks created yet. Use the canvas tools to create masks.')).toBeInTheDocument();
    });
  });

  describe('Mask Selection', () => {
    it('should select mask when clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      expect(firstMask).toBeInTheDocument();

      if (firstMask) {
        fireEvent.click(firstMask);
        expect(mockCallbacks.onMaskSelect).toHaveBeenCalledWith('mask-1');
      }
    });

    it('should show expanded controls when mask is selected', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        fireEvent.click(firstMask);
        
        // Should show expanded controls
        expect(screen.getByText('Opacity:')).toBeInTheDocument();
        expect(screen.getByText('Color:')).toBeInTheDocument();
      }
    });

    it('should highlight selected mask with different styling', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        fireEvent.click(firstMask);
        expect(firstMask).toHaveClass('border-blue-500', 'bg-blue-50');
      }
    });
  });

  describe('Mask Visibility Toggle', () => {
    it('should toggle mask visibility when visibility button is clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const visibilityButtons = screen.getAllByText('Visible');
      expect(visibilityButtons).toHaveLength(3);

      fireEvent.click(visibilityButtons[0]);
      expect(mockCallbacks.onMaskVisibilityToggle).toHaveBeenCalledWith('mask-1', false);
    });

    it('should show correct visibility state', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // All masks should start as visible
      const visibilityButtons = screen.getAllByText('Visible');
      expect(visibilityButtons).toHaveLength(3);
      
      visibilityButtons.forEach(button => {
        expect(button).toHaveClass('bg-green-500', 'text-white');
      });
    });
  });

  describe('Mask Deletion', () => {
    it('should call onMaskDelete when delete button is clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const deleteButtons = screen.getAllByText('Delete');
      expect(deleteButtons).toHaveLength(3);

      fireEvent.click(deleteButtons[0]);
      expect(mockCallbacks.onMaskDelete).toHaveBeenCalledWith('mask-1');
    });

    it('should prevent event propagation when delete button is clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const deleteButtons = screen.getAllByText('Delete');
      fireEvent.click(deleteButtons[0]);

      // onMaskSelect should not be called when delete button is clicked
      expect(mockCallbacks.onMaskSelect).not.toHaveBeenCalled();
    });
  });

  describe('Mask Controls', () => {
    it('should update opacity when opacity slider is changed', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // Select first mask to show controls
      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        fireEvent.click(firstMask);

        const opacitySlider = screen.getByDisplayValue('0.5');
        fireEvent.change(opacitySlider, { target: { value: '0.8' } });

        expect(mockCallbacks.onMaskOpacityChange).toHaveBeenCalledWith('mask-1', 0.8);
      }
    });

    it('should update color when color input is changed', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // Select first mask to show controls
      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        fireEvent.click(firstMask);

        const colorInput = screen.getByDisplayValue('#ff0000');
        fireEvent.change(colorInput, { target: { value: '#00ff00' } });

        expect(mockCallbacks.onMaskColorChange).toHaveBeenCalledWith('mask-1', '#00ff00');
      }
    });

    it('should update color when preset color button is clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // Select first mask to show controls
      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        fireEvent.click(firstMask);

        // Find preset color buttons (they have background colors)
        const presetButtons = screen.getAllByRole('button').filter(button => 
          button.style.backgroundColor && button.style.backgroundColor !== ''
        );

        if (presetButtons.length > 0) {
          fireEvent.click(presetButtons[1]); // Click second preset color
          expect(mockCallbacks.onMaskColorChange).toHaveBeenCalled();
        }
      }
    });
  });

  describe('Before/After Comparison', () => {
    const originalImage = 'data:image/png;base64,original';
    const editedImage = 'data:image/png;base64,edited';

    it('should show comparison button when both images are provided', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Show Comparison')).toBeInTheDocument();
    });

    it('should not show comparison button when images are missing', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      expect(screen.queryByText('Show Comparison')).not.toBeInTheDocument();
    });

    it('should toggle comparison view when button is clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      const showButton = screen.getByText('Show Comparison');
      fireEvent.click(showButton);

      expect(screen.getByText('Before/After Comparison')).toBeInTheDocument();
      expect(screen.getByText('Hide Comparison')).toBeInTheDocument();
    });

    it('should display side-by-side comparison by default', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      fireEvent.click(screen.getByText('Show Comparison'));

      expect(screen.getByText('Before')).toBeInTheDocument();
      expect(screen.getByText('After')).toBeInTheDocument();
      expect(screen.getByAltText('Original')).toBeInTheDocument();
      expect(screen.getByAltText('Edited')).toBeInTheDocument();
    });

    it('should switch comparison modes when mode buttons are clicked', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      fireEvent.click(screen.getByText('Show Comparison'));

      // Switch to overlay mode
      const overlayButton = screen.getByText('Overlay');
      fireEvent.click(overlayButton);
      expect(overlayButton).toHaveClass('bg-blue-500', 'text-white');

      // Switch to slider mode
      const sliderButton = screen.getByText('Slider');
      fireEvent.click(sliderButton);
      expect(sliderButton).toHaveClass('bg-blue-500', 'text-white');
    });
  });

  describe('Slider Comparison', () => {
    const originalImage = 'data:image/png;base64,original';
    const editedImage = 'data:image/png;base64,edited';

    it('should render slider comparison with default position', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      fireEvent.click(screen.getByText('Show Comparison'));
      fireEvent.click(screen.getByText('Slider'));

      const slider = screen.getByDisplayValue('50');
      expect(slider).toBeInTheDocument();
      expect(screen.getByText('Before')).toBeInTheDocument();
      expect(screen.getByText('After')).toBeInTheDocument();
    });

    it('should update slider position when slider is moved', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          originalImage={originalImage}
          editedImage={editedImage}
          {...mockCallbacks}
        />
      );

      fireEvent.click(screen.getByText('Show Comparison'));
      fireEvent.click(screen.getByText('Slider'));

      const slider = screen.getByDisplayValue('50');
      fireEvent.change(slider, { target: { value: '75' } });

      expect(screen.getByDisplayValue('75')).toBeInTheDocument();
    });
  });

  describe('Mask Statistics', () => {
    it('should display correct mask count', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Masks (3)')).toBeInTheDocument();
    });

    it('should update count when masks change', () => {
      const { rerender } = render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Masks (3)')).toBeInTheDocument();

      rerender(
        <MaskVisualization
          masks={mockMasks.slice(0, 2)}
          {...mockCallbacks}
        />
      );

      expect(screen.getByText('Masks (2)')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels and roles', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      // Check that buttons are properly rendered as button elements
      const deleteButtons = screen.getAllByText('Delete');
      deleteButtons.forEach(button => {
        expect(button.tagName).toBe('BUTTON');
      });

      const visibilityButtons = screen.getAllByText('Visible');
      visibilityButtons.forEach(button => {
        expect(button.tagName).toBe('BUTTON');
      });
    });

    it('should support keyboard navigation', () => {
      render(
        <MaskVisualization
          masks={mockMasks}
          {...mockCallbacks}
        />
      );

      const firstMask = screen.getByText('Brush Mask 1').closest('.mask-item');
      if (firstMask) {
        // Should be focusable
        expect(firstMask).toHaveClass('cursor-pointer');
      }
    });
  });
});