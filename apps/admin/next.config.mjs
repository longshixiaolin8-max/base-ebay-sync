/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Every page here is a client component fetching its own data from admin-api at
  // request time (see lib/api-client.ts) -- nothing needs Next's own server runtime, so
  // this ships as a plain static export, hostable from Amplify Hosting's manual-deploy
  // mode (no GitHub App connection/OAuth needed) or any static file host.
  output: "export",
  // Emits <route>/index.html instead of <route>.html -- static hosts (Amplify Hosting,
  // S3+CloudFront, etc.) resolve a directory request to its index.html natively, so
  // /commerce works with no custom rewrite rule; a flat commerce.html would 404 on a
  // clean-URL request without one.
  trailingSlash: true,
};

export default nextConfig;
