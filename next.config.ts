import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
  },
  async rewrites() {
    return [
      { source: "/ingest/decide", destination: "https://us.i.posthog.com/decide" },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  skipTrailingSlashRedirect: true,
  // exifr (EXIF forensics in /api/scan) dynamically requires fs/zlib for its
  // file-path readers. We only ever hand it a Buffer, but bundling it makes
  // those requires fail noisily during build — keep it external and Node
  // resolves the package normally at runtime.
  serverExternalPackages: ["exifr"],
};

export default nextConfig;
