/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: false, // avoid double-mounting terminal WebSockets in dev
  // `server.js` serves straight out of the build directory, so running
  // `next build` while `npm run dev` is up replaces a running dev server's
  // state with production output and every route starts 500ing. Set
  // NEXT_DIST_DIR to build somewhere else instead of on top of it:
  //   NEXT_DIST_DIR=.next-verify npx next build
  distDir: process.env.NEXT_DIST_DIR || '.next',
};
