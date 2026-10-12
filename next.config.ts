import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 给应用左下角的设置入口留出空间。
  devIndicators: { position: "bottom-right" },
  cacheComponents: true,
  partialPrefetching: true,
  // node:sqlite 为 Node 内置模块；音频编码与 HTTP 连接池在服务端原生加载。
  serverExternalPackages: ["@breezystack/lamejs", "undici"],
  experimental: {
    // 开发服务重启后重新建立 HMR 状态，避免复用旧构建缓存导致刷新循环。
    turbopackFileSystemCacheForDev: false,
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
