/**
 * Property-based tests for prompt engineering
 * Tests universal properties for high fidelity control effectiveness
 */

import fc from 'fast-check';
import { PromptEngine } from '../prompt-engine';
import { PromptOptions, RegionInstruction } from '../types';

describe('Prompt Engineering Properties', () => {
  const promptEngine = new PromptEngine();

  // Arbitraries for generating test data
  const arbitraryInstruction = (): fc.Arbitrary<string> =>
    fc.string({ minLength: 5, maxLength: 200 }).filter(s => s.trim().length > 0);

  const arbitraryProvider = (): fc.Arbitrary<string> =>
    fc.constantFrom('openai', 'gemini', 'modelgate', 'custom-provider');

  const arbitraryPromptOptions = (): fc.Arbitrary<PromptOptions> =>
    fc.record({
      highFidelity: fc.boolean(),
      stylePreservation: fc.boolean(),
      provider: arbitraryProvider(),
      qualityLevel: fc.constantFrom('standard', 'high')
    });

  const arbitraryRegionInstruction = (): fc.Arbitrary<RegionInstruction> =>
    fc.record({
      regionId: fc.string({ minLength: 1, maxLength: 20 }),
      instruction: arbitraryInstruction(),
      stylePreservation: fc.boolean()
    });

  /**
   * Property 6: High Fidelity Control Effectiveness
   * **Validates: Requirements 7.1, 2.2**
   * 
   * For any edit instruction, when high fidelity control is enabled, 
   * the system should prevent unwanted modifications outside the specified changes
   */
  test('Property 6: High Fidelity Control Effectiveness', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          options: arbitraryPromptOptions()
        }),
        ({ instruction, options }) => {
          const prompt = promptEngine.buildEditPrompt(instruction, options);

          // Property 1: Prompt should contain the original instruction
          expect(prompt).toContain(instruction);

          // Property 2: When high fidelity is enabled, prompt should contain precision controls
          if (options.highFidelity) {
            expect(prompt.toLowerCase()).toMatch(/precise|exact|only|specifically/);
            expect(prompt.toLowerCase()).toMatch(/do not|avoid|prevent/);
            expect(prompt).toContain('PRECISE EDITING INSTRUCTION');
          }

          // Property 3: When style preservation is enabled, prompt should contain preservation instructions
          if (options.stylePreservation) {
            expect(prompt.toLowerCase()).toMatch(/style|preserve|maintain|consistency/);
            expect(prompt).toContain('PRESERVATION');
          }

          // Property 4: High quality should add quality instructions
          if (options.qualityLevel === 'high') {
            expect(prompt.toLowerCase()).toMatch(/quality|resolution|detail/);
            expect(prompt).toContain('HIGH QUALITY REQUIREMENTS');
          }

          // Property 5: Provider adaptation should be applied
          const lowerPrompt = prompt.toLowerCase();
          switch (options.provider.toLowerCase()) {
            case 'openai':
              expect(prompt).toContain('INPUT_FIDELITY: HIGH');
              expect(prompt).toContain('=== IMAGE EDITING TASK ===');
              break;
            case 'gemini':
              expect(lowerPrompt).toMatch(/please|help|context/);
              break;
            case 'modelgate':
              expect(prompt).toContain('=== MODELGATE ROUTING ===');
              break;
            default:
              expect(prompt).toContain('IMAGE EDITING TASK');
              break;
          }

          // Property 6: Prompt should be non-empty and well-formed
          expect(prompt.trim().length).toBeGreaterThan(instruction.length);
          expect(prompt).not.toMatch(/undefined|null|\[object Object\]/);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: High Fidelity Control Consistency
   * For any instruction, applying high fidelity control should produce consistent results
   */
  test('Property: High Fidelity Control Consistency', () => {
    fc.assert(
      fc.property(
        arbitraryInstruction(),
        (instruction) => {
          const prompt1 = promptEngine.applyHighFidelityControl(instruction);
          const prompt2 = promptEngine.applyHighFidelityControl(instruction);

          // Should produce identical results
          expect(prompt1).toBe(prompt2);

          // Should contain high fidelity markers
          expect(prompt1).toContain('PRECISE EDITING INSTRUCTION');
          expect(prompt1).toContain('IMPORTANT');
          expect(prompt1).toContain('SCOPE');
          expect(prompt1).toContain('PRESERVATION');

          // Should be longer than original instruction
          expect(prompt1.length).toBeGreaterThan(instruction.length);

          // Should contain precision language
          expect(prompt1.toLowerCase()).toMatch(/only|exact|precise|specifically/);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Style Preservation Instructions
   * For any instruction and preservation level, style preservation should add appropriate controls
   */
  test('Property: Style Preservation Instructions', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          // 🔧 FIX (2026-06-11 类型门禁): 显式字面量联合，constantFrom 默认推断为 string
          level: fc.constantFrom<'strict' | 'moderate'>('strict', 'moderate')
        }),
        ({ instruction, level }) => {
          const prompt = promptEngine.addStylePreservation(instruction, level);

          // Should contain original instruction
          expect(prompt).toContain(instruction);

          // Should contain style preservation instructions
          expect(prompt).toContain('STYLE PRESERVATION');

          // Level-specific requirements
          if (level === 'strict') {
            expect(prompt).toContain('STRICT STYLE PRESERVATION');
            expect(prompt.toLowerCase()).toMatch(/exact|maintain|preserve/);
            expect(prompt.toLowerCase()).toMatch(/color temperature|lighting|texture/);
          } else {
            expect(prompt).toContain('MODERATE STYLE PRESERVATION');
            expect(prompt.toLowerCase()).toMatch(/generally|similar|basic/);
          }

          // Should be longer than original
          expect(prompt.length).toBeGreaterThan(instruction.length);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Multi-Region Prompt Coordination
   * For any set of region instructions, coordination should maintain consistency
   */
  test('Property: Multi-Region Prompt Coordination', () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryRegionInstruction(), { minLength: 1, maxLength: 5 }),
        (instructions) => {
          const coordinatedPrompts = promptEngine.coordinateMultiRegionPrompts(instructions);

          // Should return same number of prompts as instructions
          expect(coordinatedPrompts.length).toBe(instructions.length);

          coordinatedPrompts.forEach((prompt, index) => {
            // Each prompt should contain its corresponding instruction
            expect(prompt).toContain(instructions[index].instruction);

            // Each prompt should contain region ID
            expect(prompt).toContain(instructions[index].regionId);

            // Multi-region prompts should have consistency instructions
            if (instructions.length > 1) {
              expect(prompt).toContain('MULTI-REGION CONSISTENCY');
              expect(prompt).toContain(`Region ${index + 1}/${instructions.length}`);
              expect(prompt.toLowerCase()).toMatch(/consistency|coherent|balance/);
            }

            // Style preservation should be applied if requested
            if (instructions[index].stylePreservation) {
              expect(prompt.toLowerCase()).toMatch(/style|consistency|maintain/);
            }

            // Should be well-formed
            expect(prompt.trim().length).toBeGreaterThan(0);
            expect(prompt).not.toMatch(/undefined|null/);
          });

          // All prompts should be unique (different region indices)
          const uniquePrompts = new Set(coordinatedPrompts);
          expect(uniquePrompts.size).toBe(coordinatedPrompts.length);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Provider Adaptation Consistency
   * For any instruction and provider, adaptation should be consistent and appropriate
   */
  test('Property: Provider Adaptation Consistency', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          provider: arbitraryProvider()
        }),
        ({ instruction, provider }) => {
          const adaptedPrompt1 = promptEngine.adaptForProvider(instruction, provider);
          const adaptedPrompt2 = promptEngine.adaptForProvider(instruction, provider);

          // Should be consistent
          expect(adaptedPrompt1).toBe(adaptedPrompt2);

          // Should contain original instruction
          expect(adaptedPrompt1).toContain(instruction);

          // Should be longer than original (adds provider-specific content)
          expect(adaptedPrompt1.length).toBeGreaterThan(instruction.length);

          // Provider-specific adaptations
          const lowerPrompt = adaptedPrompt1.toLowerCase();
          switch (provider.toLowerCase()) {
            case 'openai':
              expect(adaptedPrompt1).toContain('INPUT_FIDELITY: HIGH');
              expect(adaptedPrompt1).toContain('=== IMAGE EDITING TASK ===');
              expect(adaptedPrompt1).toContain('TECHNICAL PARAMETERS');
              break;
            case 'gemini':
              expect(lowerPrompt).toMatch(/please|help/);
              expect(lowerPrompt).toContain('context');
              break;
            case 'modelgate':
              expect(adaptedPrompt1).toContain('=== MODELGATE ROUTING ===');
              expect(adaptedPrompt1).toContain('MODEL REQUIREMENTS');
              break;
            default:
              expect(adaptedPrompt1).toContain('IMAGE EDITING TASK');
              expect(lowerPrompt).toContain('precisely');
              break;
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property: Prompt Refinement Preservation
   * For any prompt and refinement parameters, refinement should preserve original content
   */
  test('Property: Prompt Refinement Preservation', () => {
    fc.assert(
      fc.property(
        fc.record({
          originalPrompt: arbitraryInstruction(),
          targetQuality: fc.constantFrom('high', 'standard', 'detailed')
        }),
        ({ originalPrompt, targetQuality }) => {
          // Mock previous result (in real implementation this would be actual result analysis)
          const mockResult = { needsRefinement: false };
          
          const refinedPrompt = promptEngine.refinePromptForQuality(
            originalPrompt, 
            mockResult, 
            targetQuality
          );

          // Should preserve original prompt
          expect(refinedPrompt).toContain(originalPrompt);

          // Should be at least as long as original
          expect(refinedPrompt.length).toBeGreaterThanOrEqual(originalPrompt.length);

          // Should be well-formed
          expect(refinedPrompt.trim().length).toBeGreaterThan(0);
          expect(refinedPrompt).not.toMatch(/undefined|null/);

          // If refinements were added, should contain refinement markers
          if (refinedPrompt.length > originalPrompt.length) {
            expect(refinedPrompt).toContain('REFINEMENT INSTRUCTIONS');
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * Property: Prompt Structure Integrity
   * For any valid inputs, generated prompts should maintain structural integrity
   */
  test('Property: Prompt Structure Integrity', () => {
    fc.assert(
      fc.property(
        fc.record({
          instruction: arbitraryInstruction(),
          options: arbitraryPromptOptions()
        }),
        ({ instruction, options }) => {
          const prompt = promptEngine.buildEditPrompt(instruction, options);

          // Should not contain undefined or null values
          expect(prompt).not.toMatch(/undefined|null|\[object Object\]/);

          // Should not have excessive whitespace
          expect(prompt).not.toMatch(/\n\n\n\n/); // No more than 3 consecutive newlines

          // Should not be empty
          expect(prompt.trim().length).toBeGreaterThan(0);

          // Should contain meaningful content
          expect(prompt.split(/\s+/).length).toBeGreaterThan(5); // At least 5 words

          // Should maintain reasonable length (not excessively long)
          expect(prompt.length).toBeLessThan(5000); // Reasonable upper bound

          // Should contain the original instruction
          expect(prompt).toContain(instruction);
        }
      ),
      { numRuns: 100 }
    );
  });
});