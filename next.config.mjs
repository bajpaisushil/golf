/** @type {import('next').NextConfig} */
// Static export: the entire app compiles to plain HTML/JS/CSS in `out/`.
// There is no server runtime, no API routes, no database. See README "Deployment".
const nextConfig = {
  // Multiple lockfiles exist above this directory; pin the tracing root to this app.
  outputFileTracingRoot: import.meta.dirname,
  output: 'export',
  images: { unoptimized: true },
  reactStrictMode: true,
  trailingSlash: true,
};
export default nextConfig;
