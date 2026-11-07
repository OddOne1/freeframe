/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  env: {
    // Always defined, so Next inlines it even when unset: lib/snippet-api.ts
    // then compiles `"" === "1"`, and webpack drops the dev-only fixture
    // module (lib/snippet-fixtures.ts) instead of shipping it as a lazy
    // chunk. Unset, Next leaves a runtime lookup and the chunk is emitted.
    NEXT_PUBLIC_SNIPPET_FIXTURES: process.env.NEXT_PUBLIC_SNIPPET_FIXTURES || '',
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '9000',
      },
    ],
  },
}

module.exports = nextConfig
