import type { NextConfig } from 'next'

const isProd = process.env.NODE_ENV === 'production'

const cspScriptSrc = isProd
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'"

// Build the exact S3 hostname so CSP wildcards are not needed
const s3Host = process.env.S3_BUCKET_NAME && process.env.AWS_REGION
  ? `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com`
  : 'https://*.amazonaws.com'

const nextConfig: NextConfig = {
  // sharp must run in the Node.js runtime, not the Edge runtime
  serverExternalPackages: ['sharp'],

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              cspScriptSrc,
              "style-src 'self' 'unsafe-inline'",
              `img-src 'self' data: blob: ${s3Host} https://server.arcgisonline.com`,
              `media-src 'self' blob: ${s3Host}`,
              "font-src 'self'",
              `connect-src 'self' ${s3Host} https://tiles.openfreemap.org https://server.arcgisonline.com`,
              "worker-src blob: 'self'",

              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
