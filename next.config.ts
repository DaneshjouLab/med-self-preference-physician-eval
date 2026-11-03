import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  poweredByHeader: false,
  // Migrations are applied at startup; ship only them (never .source/ or data/study/prepared/).
  outputFileTracingIncludes: { "/**/*": ["./drizzle/**/*"] },
  outputFileTracingExcludes: { "/**/*": ["./.source/**/*", "./data/**/*", "./.data/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
