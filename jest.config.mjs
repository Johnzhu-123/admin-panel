/** @type {import('jest').Config} */
export default {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  testEnvironment: "jsdom",
  roots: ["<rootDir>/lib", "<rootDir>/app"],
  testMatch: [
    "**/__tests__/**/*.ts",
    "**/__tests__/**/*.tsx",
    "**/?(*.)+(spec|test).ts",
    "**/?(*.)+(spec|test).tsx",
  ],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          jsx: "react-jsx",
        },
      },
    ],
  },
  collectCoverageFrom: [
    "lib/**/*.ts",
    "lib/**/*.tsx",
    "app/**/*.ts",
    "app/**/*.tsx",
    "!**/*.d.ts",
    "!**/*.test.ts",
    "!**/*.test.tsx",
    "!**/*.spec.ts",
    "!**/*.spec.tsx",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
};
