import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
    poolOptions: {
      workers: {
        wrangler: {
          configPath: './wrangler.test.toml',
        },
        miniflare: {
          bindings: {
            VERIFONE_CLIENT_ID: 'test-verifone-id',
            VERIFONE_CLIENT_SECRET: 'test-verifone-secret',
            VERIFONE_SCOPE: 'checkout',
            VERIFONE_ENTITY_ID: 'test-entity',
            VERIFONE_PAYMENT_CONTRACT_ID: 'test-contract',
            VERIFONE_3DS_CONTRACT_ID: 'test-3ds-contract',
            VERIFONE_JWKS_URL: 'https://jwks.test.verifone/keys',
            LANDSBANKINN_CLIENT_ID: 'test-lb-id',
            LANDSBANKINN_CLIENT_SECRET: 'test-lb-secret',
            LANDSBANKINN_SCOPE: 'acquiring',
          },
        },
      },
    },
  },
});
