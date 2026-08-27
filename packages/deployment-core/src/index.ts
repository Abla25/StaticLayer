/**
 * @staticlayer/deployment-core — library-first Desired State Engine + API
 * client, shared by @staticlayer/cli and @staticlayer/installer.
 *
 * Phase 4 audit: this package is the ONLY home of the Cloudflare deploy
 * logic. It has no process.exit, no prompts, no console side effects.
 */
export * from './types.ts';
export * from './api.ts';
export * from './engine.ts';
export * from './build-worker.ts';
export { MockCloudflareApi } from './mock-api.ts';
