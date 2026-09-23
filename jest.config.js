// Fixed NEGATIVE-offset zone: Jest's node environment deep-copies process.env
// at setup, so a test cannot change TZ at runtime and have Date's local-time
// methods see it (jestjs/jest#9856). Activity-log timestamps are stored as
// RFC3339 UTC but displayed with local-time methods, so a UTC/local mix-up
// must actually change what a test sees.
process.env.TZ = 'America/Los_Angeles';

module.exports = {
  projects: [
    {
      displayName: 'logic',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/(domain|storage|platform|webrtc)/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['babel-jest', { presets: ['babel-preset-expo'] }],
      },
    },
    {
      displayName: 'screens',
      preset: 'jest-expo',
      testMatch: ['<rootDir>/src/**/*.test.tsx'],
      setupFiles: ['<rootDir>/jest/setupScreens.ts'],
      transformIgnorePatterns: [
        '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@material/material-color-utilities))',
      ],
    },
  ],
};
