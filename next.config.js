const nextConfig = {
  output: 'standalone',
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: 'avatars.githubusercontent.com', pathname: '/**' },
    ],
  },
  // Renamed from experimental.serverComponentsExternalPackages in Next 15
  serverExternalPackages: ['mongodb'],
  webpack(config, { dev }) {
    if (dev) {
      // Reduce CPU/memory from file watching
      config.watchOptions = {
        poll: 2000, // check every 2 seconds
        aggregateTimeout: 300, // wait before rebuilding
        ignored: ['**/node_modules'],
      };
    }
    return config;
  },
  onDemandEntries: {
    maxInactiveAge: 10000,
    pagesBufferLength: 2,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "ALLOWALL" },
          { key: "Content-Security-Policy", value: "frame-ancestors *;" },
          // CORS NAO mora aqui (2026-11-20): `headers()` e avaliado no BUILD da
          // imagem standalone, quando CORS_ORIGINS ainda nao existe — o valor
          // congelava em "*" e SOBREPUNHA o header correto que `cors()` em
          // app/api/[[...path]]/route.js define em runtime a partir da
          // variavel. A API ja trata CORS sozinha; paginas nao precisam dele.
        ],
      },
    ];
  },
};

module.exports = nextConfig;
