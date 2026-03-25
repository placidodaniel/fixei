export default {
    testEnvironment: 'node',
    transform: {},
    testMatch: ['<rootDir>/tests/**/*.test.js'],
    collectCoverageFrom: ['<rootDir>/src/**/*.js'],
    coverageReporters: ['text', 'lcov'],
};
