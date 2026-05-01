/**
 * Property-based tests for style preservation
 * Tests universal properties for style preservation consistency
 */

import fc from 'fast-check';
import { PromptEngine } from '../prompt-engine';
import { RegionInstruction } from '../types';

describe('Style Preservation Properties', () => {
  const promptEngine = new PromptEngine();

  // Arbitraries for generating test data
  const arbitraryInstruction = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 5, maxLength: 200 }).filter(s => s.trim().length > 0);

  const arbitraryRegionInstruction = (): fc.Arbitrary<RegionInstruction> =>
    fc.record({
      regionId: fc.string({ minLength: 1, maxLength: 20 }),
      instruction: arbitraryInstruction(),
      stylePreservation: fc.boolean()
    });

  const arbitraryPreservationLevel = (): fc.Arbitrary<'strict' | 'moderate'> =>
    fc.constantFrom('strict', 'moderate');

  /**
   * Property 7: Style Preservation Consistency
   * **Validates: Requirements 7.2, 2.3**
   * 
   * For any image with style preservation enabled, the edited result should maintain 
   * the original image's style characteristics in non-edited regions
   */
  test('Property 7: Style Preservation Consistency', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          preservationLevel: arbitraryPreservationLevel()
        }),
        ({ instruction, preservationLevel }) => {
          const preservedPrompt = promptEngine.addStylePreservation(instruction, preservationLevel);

          // Property 1: Should contain original instruction
          expect(preservedPrompt).toContain(instruction);

          // Property 2: Should contain style preservation markers
          expect(preservedPrompt).toContain('STYLE PRESERVATION');

          // Property 3: Level-specific requirements should be present
          if (preservationLevel === 'strict') {
            expect(preservedPrompt).toContain('STRICT STYLE PRESERVATION');
            
            // Strict preservation should include detailed requirements
            const strictRequirements = [
              'color temperature',
              'lighting direction',
              'texture',
              'material properties',
              'artistic techniques',
              'style consistency',
              'depth of field'
            ];
            
            const lowerPrompt = preservedPrompt.toLowerCase();
            const foundRequirements = strictRequirements.filter(req => 
              lowerPrompt.includes(req.toLowerCase())
            );
            
            // Should contain most strict requirements
            expect(foundRequirements.length).toBeGreaterThanOrEqual(4);
            
          } else {
            expect(preservedPrompt).toContain('MODERATE STYLE PRESERVATION');
            
            // Moderate preservation should include basic requirements
            const moderateRequirements = [
              'visual style',
              'color palette',
              'lighting characteristics',
              'artistic approach'
            ];
            
            const lowerPrompt = preservedPrompt.toLowerCase();
            const foundRequirements = moderateRequirements.filter(req => 
              lowerPrompt.includes(req.toLowerCase())
            );
            
            // Should contain most moderate requirements
            expect(foundRequirements.length).toBeGreaterThanOrEqual(2);
          }

          // Property 4: Should be longer than original instruction
          expect(preservedPrompt.length).toBeGreaterThan(instruction.length);

          // Property 5: Should contain preservation keywords
          const preservationKeywords = ['maintain', 'preserve', 'keep', 'consistent'];
          const lowerPrompt = preservedPrompt.toLowerCase();
          const foundKeywords = preservationKeywords.filter(keyword => 
            lowerPrompt.includes(keyword)
          );
          expect(foundKeywords.length).toBeGreaterThanOrEqual(2);

          // Property 6: Should be well-structured
          expect(preservedPrompt).not.toMatch(/undefined|null/);
          expect(preservedPrompt.trim().length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Style Preservation Determinism
   * For any instruction and preservation level, results should be deterministic
   */
  test('Property: Style Preservation Determinism', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          level: arbitraryPreservationLevel()
        }),
        ({ instruction, level }) => {
          const result1 = promptEngine.addStylePreservation(instruction, level);
          const result2 = promptEngine.addStylePreservation(instruction, level);

          // Should produce identical results
          expect(result1).toBe(result2);

          // Should be consistent across multiple calls
          for (let i = 0; i < 5; i++) {
            const resultN = promptEngine.addStylePreservation(instruction, level);
            expect(resultN).toBe(result1);
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Multi-Region Style Consistency
   * For any set of regions with style preservation, coordination should maintain consistency
   */
  test('Property: Multi-Region Style Consistency', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryRegionInstruction(), { minLength: 2, maxLength: 5 })
          .filter(instructions => instructions.some(i => i.stylePreservation)),
        (instructions) => {
          const coordinatedPrompts = promptEngine.coordinateMultiRegionPrompts(instructions);

          expect(coordinatedPrompts.length).toBe(instructions.length);

          // Check each prompt for style preservation requirements
          coordinatedPrompts.forEach((prompt, index) => {
            const instruction = instructions[index];

            // Should contain original instruction
            expect(prompt).toContain(instruction.instruction);

            // If style preservation is enabled for this region
            if (instruction.stylePreservation) {
              expect(prompt.toLowerCase()).toMatch(/style|consistency|maintain/);
            }

            // Multi-region prompts should have global consistency instructions
            expect(prompt).toContain('MULTI-REGION CONSISTENCY');
            expect(prompt.toLowerCase()).toMatch(/lighting consistency|color relationships|composition/);
          });

          // All prompts should reference the same total number of regions
          const totalRegions = instructions.length;
          coordinatedPrompts.forEach(prompt => {
            expect(prompt).toContain(`/${totalRegions}`);
          });

          // Style preservation regions should have additional consistency requirements
          const stylePreservationPrompts = coordinatedPrompts.filter((prompt, index) => 
            instructions[index].stylePreservation
          );

          if (stylePreservationPrompts.length > 0) {
            stylePreservationPrompts.forEach(prompt => {
              expect(prompt.toLowerCase()).toMatch(/maintain|preserve|consistency/);
            });
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Style Preservation Hierarchy
   * Strict preservation should include all moderate preservation requirements plus additional ones
   */
  test('Property: Style Preservation Hierarchy', () => {
    fc.assert(
      fc.property(
        arbitraryInstruction(),
        (instruction) => {
          const strictPrompt = promptEngine.addStylePreservation(instruction, 'strict');
          const moderatePrompt = promptEngine.addStylePreservation(instruction, 'moderate');

          // Both should contain the original instruction
          expect(strictPrompt).toContain(instruction);
          expect(moderatePrompt).toContain(instruction);

          // Strict should be longer (more detailed requirements)
          expect(strictPrompt.length).toBeGreaterThan(moderatePrompt.length);

          // Both should contain style preservation markers
          expect(strictPrompt).toContain('STYLE PRESERVATION');
          expect(moderatePrompt).toContain('STYLE PRESERVATION');

          // Strict should contain more specific requirements
          const strictSpecificTerms = [
            'exact color temperature',
            'lighting direction',
            'texture',
            'brush strokes',
            'depth of field'
          ];

          const moderateGeneralTerms = [
            'generally maintain',
            'similar color palette',
            'basic lighting',
            'general artistic'
          ];

          const strictLower = strictPrompt.toLowerCase();
          const moderateLower = moderatePrompt.toLowerCase();

          // Strict should contain specific terms
          const strictMatches = strictSpecificTerms.filter(term => 
            strictLower.includes(term.toLowerCase())
          );
          expect(strictMatches.length).toBeGreaterThanOrEqual(2);

          // Moderate should contain general terms
          const moderateMatches = moderateGeneralTerms.filter(term => 
            moderateLower.includes(term.toLowerCase())
          );
          expect(moderateMatches.length).toBeGreaterThanOrEqual(1);

          // Strict should not contain moderate's general language
          expect(strictLower).not.toContain('generally maintain');
          expect(strictLower).not.toContain('similar color palette');
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Style Preservation Context Awareness
   * Style preservation should adapt appropriately to different instruction contexts
   */
  test('Property: Style Preservation Context Awareness', () => {
    fc.assert(
      fc.property(
        fc.record({
          baseInstruction: arbitraryInstruction(),
          level: arbitraryPreservationLevel(),
          contextType: fc.constantFrom('color-change', 'object-addition', 'texture-modification', 'lighting-adjustment')
        }),
        ({ baseInstruction, level, contextType }) => {
          // Create context-specific instruction
          const contextualInstruction = `${contextType}: ${baseInstruction}`;
          const preservedPrompt = promptEngine.addStylePreservation(contextualInstruction, level);

          // Should contain both context and preservation instructions
          expect(preservedPrompt).toContain(contextualInstruction);
          expect(preservedPrompt).toContain('STYLE PRESERVATION');

          // Should be contextually appropriate
          const lowerPrompt = preservedPrompt.toLowerCase();
          
          // All contexts should have basic preservation requirements
          expect(lowerPrompt).toMatch(/maintain|preserve|consistent/);

          // Context-specific validation
          switch (contextType) {
            case 'color-change':
              if (level === 'strict') {
                expect(lowerPrompt).toMatch(/color temperature|saturation/);
              }
              break;
            case 'lighting-adjustment':
              if (level === 'strict') {
                expect(lowerPrompt).toMatch(/lighting direction|intensity/);
              }
              break;
            case 'texture-modification':
              if (level === 'strict') {
                expect(lowerPrompt).toMatch(/texture|material properties/);
              }
              break;
          }

          // Should maintain structural integrity
          expect(preservedPrompt).not.toMatch(/undefined|null/);
          expect(preservedPrompt.trim().length).toBeGreaterThan(contextualInstruction.length);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Style Preservation Completeness
   * Style preservation instructions should cover all major visual aspects
   */
  test('Property: Style Preservation Completeness', () => {
    fc.assert(
      fc.property(
        arbitraryInstruction(),
        (instruction) => {
          const strictPrompt = promptEngine.addStylePreservation(instruction, 'strict');
          const moderatePrompt = promptEngine.addStylePreservation(instruction, 'moderate');

          // Define major visual aspects that should be covered
          const majorAspects = {
            color: ['color', 'palette', 'temperature', 'saturation'],
            lighting: ['lighting', 'light', 'illumination', 'brightness'],
            texture: ['texture', 'material', 'surface'],
            style: ['style', 'artistic', 'aesthetic', 'visual'],
            composition: ['composition', 'balance', 'focus', 'depth']
          };

          // Check coverage for strict preservation
          const strictLower = strictPrompt.toLowerCase();
          let strictCoverage = 0;
          
          Object.values(majorAspects).forEach(aspectTerms => {
            const hasAspect = aspectTerms.some(term => strictLower.includes(term));
            if (hasAspect) strictCoverage++;
          });

          // Strict should cover most major aspects
          expect(strictCoverage).toBeGreaterThanOrEqual(4);

          // Check coverage for moderate preservation
          const moderateLower = moderatePrompt.toLowerCase();
          let moderateCoverage = 0;
          
          Object.values(majorAspects).forEach(aspectTerms => {
            const hasAspect = aspectTerms.some(term => moderateLower.includes(term));
            if (hasAspect) moderateCoverage++;
          });

          // Moderate should cover basic aspects
          expect(moderateCoverage).toBeGreaterThanOrEqual(2);

          // Strict should have better coverage than moderate
          expect(strictCoverage).toBeGreaterThanOrEqual(moderateCoverage);
        }
      ),
      { numRuns: 50 }
    );
  });
});