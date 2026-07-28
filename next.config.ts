import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/financeiro", destination: "/dashboard", permanent: false },
      { source: "/financeiro/:path*", destination: "/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
