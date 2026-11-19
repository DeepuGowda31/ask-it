import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Optional separate build folder (e.g. to verify a build without touching a running server).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  turbopack: { root: rootDir },
};

export default nextConfig;
