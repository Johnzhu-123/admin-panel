// Basic setup test to verify Jest and fast-check are working

import * as fc from 'fast-check';

describe('Test Setup', () => {
  test('Jest is working correctly', () => {
    expect(1 + 1).toBe(2);
  });

  test('fast-check is working correctly', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a; // Commutative property
      })
    );
  });

  test('TypeScript compilation is working', () => {
    interface TestInterface {
      value: number;
    }
    
    const testObj: TestInterface = { value: 42 };
    expect(testObj.value).toBe(42);
  });
});