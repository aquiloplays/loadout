// aquilo-site Next.js config.
//
// The site proxies HMAC-signed admin calls through to the loadout-discord
// Worker at loadout-discord.aquiloplays.workers.dev. NEXT_PUBLIC_WORKER_BASE
// is read at build time so the client knows where /tikfinity/event lives
// (the wizard's "Paste this URL" step needs the public, externally
// reachable origin, not the local site origin).
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_WORKER_BASE: process.env.NEXT_PUBLIC_WORKER_BASE
      || 'https://loadout-discord.aquiloplays.workers.dev',
  },
};

export default nextConfig;
