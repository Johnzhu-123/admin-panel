/**
 * Enhanced prompt engineering system for AI image editing
 * Implements high fidelity control and style preservation techniques
 */

import { 
  PromptOptions, 
  HighFidelityOptions, 
  RegionInstruction,
  EditRegion 
} from './types';

export class PromptEngine {
  /**
   * Builds an edit prompt with high fidelity control
   */
  buildEditPrompt(instruction: string, options: PromptOptions): string {
    let prompt = instruction;

    // Apply high fidelity control if enabled
    if (options.highFidelity) {
      prompt = this.applyHighFidelityControl(prompt);
    }

    // Apply style preservation if enabled
    if (options.stylePreservation) {
      prompt = this.addStylePreservation(prompt, 'strict');
    }

    // Adapt for specific provider
    prompt = this.adaptForProvider(prompt, options.provider);

    // Add quality level instructions
    if (options.qualityLevel === 'high') {
      prompt = this.addQualityInstructions(prompt);
    }

    return prompt;
  }

  /**
   * Applies high fidelity control techniques to prevent over-interpretation
   */
  applyHighFidelityControl(prompt: string): string {
    const highFidelityOptions: HighFidelityOptions = {
      preventOverInterpretation: true,
      maintainOriginalStyle: true,
      focusOnMaskedRegions: true,
      preserveUnmaskedAreas: true
    };

    return this.buildHighFidelityPrompt(prompt, highFidelityOptions);
  }

  /**
   * Adds style preservation instructions to the prompt
   */
  addStylePreservation(prompt: string, preservationLevel: 'strict' | 'moderate'): string {
    const preservationInstructions = this.getStylePreservationInstructions(preservationLevel);
    return `${prompt}\n\n${preservationInstructions}`;
  }

  /**
   * Coordinates prompts for multiple edit regions
   */
  coordinateMultiRegionPrompts(instructions: RegionInstruction[]): string[] {
    const coordinatedPrompts: string[] = [];
    
    // Build context for consistency
    const globalContext = this.buildGlobalContext(instructions);
    
    instructions.forEach((instruction, index) => {
      let prompt = instruction.instruction;
      
      // Add global context for consistency
      prompt = this.addGlobalContext(prompt, globalContext, index);
      
      // Add region-specific instructions
      prompt = this.addRegionSpecificInstructions(prompt, instruction);
      
      // Add consistency instructions for multi-region editing
      if (instructions.length > 1) {
        prompt = this.addConsistencyInstructions(prompt, index, instructions.length);
      }
      
      coordinatedPrompts.push(prompt);
    });
    
    return coordinatedPrompts;
  }

  /**
   * Adapts prompt for specific provider capabilities
   */
  adaptForProvider(prompt: string, provider: string): string {
    switch (provider.toLowerCase()) {
      case 'openai':
        return this.adaptForOpenAI(prompt);
      case 'gemini':
        return this.adaptForGemini(prompt);
      case 'modelgate':
        return this.adaptForModelGate(prompt);
      default:
        return this.adaptForGenericProvider(prompt);
    }
  }

  // Private helper methods

  private buildHighFidelityPrompt(prompt: string, options: HighFidelityOptions): string {
    const components: string[] = [];
    
    // Base instruction with precision emphasis
    components.push(`PRECISE EDITING INSTRUCTION: ${prompt}`);
    
    if (options.preventOverInterpretation) {
      components.push(
        "IMPORTANT: Make ONLY the changes explicitly requested. " +
        "Do not add, remove, or modify anything beyond what is specifically described. " +
        "Do not interpret or expand on the instruction."
      );
    }
    
    if (options.focusOnMaskedRegions) {
      components.push(
        "SCOPE: Apply changes ONLY within the masked/selected regions. " +
        "The mask defines the exact boundaries of what should be modified."
      );
    }
    
    if (options.preserveUnmaskedAreas) {
      components.push(
        "PRESERVATION: Keep all areas outside the mask completely unchanged. " +
        "Maintain exact colors, textures, lighting, and details in unmasked regions."
      );
    }
    
    if (options.maintainOriginalStyle) {
      components.push(
        "STYLE CONSISTENCY: Maintain the original image's artistic style, " +
        "color palette, lighting conditions, and visual characteristics. " +
        "New elements should seamlessly blend with the existing aesthetic."
      );
    }
    
    return components.join('\n\n');
  }

  private getStylePreservationInstructions(level: 'strict' | 'moderate'): string {
    if (level === 'strict') {
      return [
        "STRICT STYLE PRESERVATION:",
        "- Maintain exact color temperature and saturation levels",
        "- Preserve original lighting direction and intensity", 
        "- Keep consistent texture and material properties",
        "- Match existing brush strokes or artistic techniques",
        "- Maintain photographic or artistic style consistency",
        "- Preserve depth of field and focus characteristics"
      ].join('\n');
    } else {
      return [
        "MODERATE STYLE PRESERVATION:",
        "- Generally maintain the overall visual style",
        "- Keep similar color palette and mood",
        "- Preserve basic lighting characteristics",
        "- Maintain general artistic approach"
      ].join('\n');
    }
  }

  private buildGlobalContext(instructions: RegionInstruction[]): string {
    const contexts: string[] = [];
    
    // Identify common themes
    const hasStylePreservation = instructions.some(i => i.stylePreservation);
    if (hasStylePreservation) {
      contexts.push("This is part of a multi-region edit with style preservation requirements.");
    }
    
    // Add coordination context
    if (instructions.length > 1) {
      contexts.push(
        `This edit is part of ${instructions.length} coordinated changes to the same image. ` +
        "Maintain visual consistency across all edited regions."
      );
    }
    
    return contexts.join(' ');
  }

  private addGlobalContext(prompt: string, globalContext: string, regionIndex: number): string {
    if (!globalContext) return prompt;
    
    return `${globalContext}\n\nREGION ${regionIndex + 1} EDIT: ${prompt}`;
  }

  private addRegionSpecificInstructions(prompt: string, instruction: RegionInstruction): string {
    const additions: string[] = [];
    
    if (instruction.stylePreservation) {
      additions.push("Maintain style consistency with the original image.");
    }
    
    // Add region ID for tracking
    additions.push(`[Region ID: ${instruction.regionId}]`);
    
    if (additions.length > 0) {
      return `${prompt}\n\nADDITIONAL REQUIREMENTS:\n${additions.join('\n')}`;
    }
    
    return prompt;
  }

  private addConsistencyInstructions(prompt: string, regionIndex: number, totalRegions: number): string {
    const consistencyInstructions = [
      `MULTI-REGION CONSISTENCY (Region ${regionIndex + 1}/${totalRegions}):`,
      "- Ensure lighting consistency across all edited regions",
      "- Maintain coherent color relationships between regions", 
      "- Preserve overall image composition and balance",
      "- Avoid creating visual discontinuities at region boundaries"
    ].join('\n');
    
    return `${prompt}\n\n${consistencyInstructions}`;
  }

  private addQualityInstructions(prompt: string): string {
    const qualityInstructions = [
      "HIGH QUALITY REQUIREMENTS:",
      "- Generate at maximum available resolution",
      "- Ensure sharp, detailed results without artifacts",
      "- Maintain high fidelity in textures and fine details",
      "- Avoid compression artifacts or quality degradation"
    ].join('\n');
    
    return `${prompt}\n\n${qualityInstructions}`;
  }

  // Provider-specific adaptations

  private adaptForOpenAI(prompt: string): string {
    // OpenAI-specific optimizations
    const adaptations: string[] = [];
    
    // Use OpenAI's input_fidelity parameter support
    adaptations.push("INPUT_FIDELITY: HIGH");
    
    // OpenAI responds well to structured instructions
    adaptations.push("TASK TYPE: Precise image editing with mask-based region control");
    
    // Add OpenAI-specific formatting
    const structuredPrompt = [
      "=== IMAGE EDITING TASK ===",
      prompt,
      "",
      "=== TECHNICAL PARAMETERS ===",
      ...adaptations
    ].join('\n');
    
    return structuredPrompt;
  }

  private adaptForGemini(prompt: string): string {
    // Gemini-specific optimizations
    const adaptations: string[] = [];
    
    // Gemini works well with conversational tone
    adaptations.push("Please help me edit this image with precision and care.");
    
    // Gemini benefits from explicit context
    adaptations.push("Context: This is a professional image editing task requiring exact adherence to instructions.");
    
    const conversationalPrompt = [
      adaptations[0],
      "",
      prompt,
      "",
      adaptations[1]
    ].join('\n');
    
    return conversationalPrompt;
  }

  private adaptForModelGate(prompt: string): string {
    // ModelGate-specific optimizations
    const adaptations: string[] = [];
    
    // ModelGate may route to different models, so be explicit
    adaptations.push("MODEL REQUIREMENTS: Use image editing specialized model if available");
    
    // Add clear formatting for routing
    const routedPrompt = [
      "=== MODELGATE ROUTING ===",
      ...adaptations,
      "",
      "=== EDIT INSTRUCTION ===", 
      prompt
    ].join('\n');
    
    return routedPrompt;
  }

  private adaptForGenericProvider(prompt: string): string {
    // Generic provider adaptations - keep it simple and clear
    return `IMAGE EDITING TASK:\n\n${prompt}\n\nPlease follow the instructions precisely and maintain image quality.`;
  }

  /**
   * Implements iterative refinement strategies for quality improvement
   */
  refinePromptForQuality(originalPrompt: string, previousResult: any, targetQuality: string): string {
    const refinements: string[] = [];
    
    // Analyze previous result (this would be implemented based on actual result analysis)
    if (this.needsDetailImprovement(previousResult)) {
      refinements.push("ENHANCEMENT: Increase detail level and sharpness in the edited regions.");
    }
    
    if (this.needsColorCorrection(previousResult)) {
      refinements.push("COLOR CORRECTION: Adjust color balance to better match the original image.");
    }
    
    if (this.needsBoundaryRefinement(previousResult)) {
      refinements.push("BOUNDARY REFINEMENT: Improve blending at the edges of edited regions.");
    }
    
    if (refinements.length > 0) {
      return `${originalPrompt}\n\nREFINEMENT INSTRUCTIONS:\n${refinements.join('\n')}`;
    }
    
    return originalPrompt;
  }

  // Quality analysis helpers (placeholder implementations)
  private needsDetailImprovement(result: any): boolean {
    // This would analyze the result for detail quality
    return false; // Placeholder
  }

  private needsColorCorrection(result: any): boolean {
    // This would analyze color consistency
    return false; // Placeholder
  }

  private needsBoundaryRefinement(result: any): boolean {
    // This would analyze edge blending quality
    return false; // Placeholder
  }
}

export const promptEngine = new PromptEngine();