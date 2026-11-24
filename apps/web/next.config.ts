import type { NextConfig } from "next";

// The browser only ever talks to Next.js. Requests to /backend/* are forwarded
// to the Express API on 127.0.0.1, so the API never needs to be exposed itself
// and we don't need CORS.
const API_URL = process.env.SAARTHI_API_URL ?? "http://127.0.0.1:4000";

const config: NextConfig = {
  // Hide the floating Next.js dev badge so it doesn't appear in video recordings.
  devIndicators: false,
  async rewrites() {
    return [{ source: "/backend/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default config;
