/** 常驻 Node 服务启动即接续持久任务，无需等待浏览器访问。 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build" && process.env.NEXT_PHASE !== "phase-export") {
    const { startBackgroundWorker } = await import("./lib/generation/worker");
    startBackgroundWorker();
  }
}
