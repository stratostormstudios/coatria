import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  // Purchased runtime models are supplied privately by the licensed operator.
  // They are not public files or part of the open-source repository.
  outputFileTracingIncludes: {
    '/api/avatars/*/model': ['./.runtime-assets/city-characters/*.glb'],
    '/api/avatars/*/preview': ['./.runtime-assets/city-characters/*.png'],
    '/api/office-assets/*/model': ['./.runtime-assets/office-models/*.glb'],
    '/api/office-assets/*/preview': ['./.runtime-assets/office-models/*.png'],
    '/api/office-assets/*/plan': ['./.runtime-assets/office-models/*.plan.png']
  },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()' }
    ] }];
  }
};
export default config;
