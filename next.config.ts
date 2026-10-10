import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // node:sqlite 为 Node 内置模块；lamejs 体积大且只在服务端用，不参与打包
  serverExternalPackages: ["@breezystack/lamejs"],
  experimental: {
    // proxy.ts 会缓冲请求体，默认上限 10MB，超出部分被静默截断。
    // 导入备份（zip，含全部 mp3）可能较大，这里放宽上限。
    proxyClientMaxBodySize: "2gb",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
