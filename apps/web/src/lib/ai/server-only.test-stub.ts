// Vitest runs outside Next.js and cannot resolve its built-in server-only marker.
// This alias is test-only; Next.js still rejects client imports during the build.
export {};
