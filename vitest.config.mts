import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.test.toml',
      },
      miniflare: {
        bindings: {
          VERIFONE_USER_ID: 'test-verifone-user-id',
          VERIFONE_API_KEY: 'test-verifone-api-key',
          VERIFONE_ENTITY_ID: 'test-entity',
          VERIFONE_PAYMENT_CONTRACT_ID: 'test-contract',
          VERIFONE_3DS_CONTRACT_ID: 'test-3ds-contract',
          VERIFONE_JWKS_URL: 'https://jwks.test.verifone/keys',
          LANDSBANKINN_CLIENT_ID: 'test-lb-id',
          LANDSBANKINN_CLIENT_SECRET: 'test-lb-secret',
          LANDSBANKINN_SCOPE: 'acquiring',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/types/**'],
      thresholds: {
        statements: 74,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});
