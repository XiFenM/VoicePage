import "server-only";
import { Agent, type Dispatcher } from "undici";
import { MODEL_REQUEST_TIMEOUT_MS } from "./generation/timeouts";

/** 仅供模型请求使用，不更改 Next.js 或其他 fetch 的全局连接设置。 */
export class ModelAgent extends Agent {
  constructor() {
    super({ headersTimeout: MODEL_REQUEST_TIMEOUT_MS, bodyTimeout: MODEL_REQUEST_TIMEOUT_MS });
  }

  override dispatch(options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    // 在真正发送处显式设置，避免不同 Node/fetch 版本携带的默认值覆盖 Agent 配置。
    return super.dispatch({ ...options, headersTimeout: MODEL_REQUEST_TIMEOUT_MS, bodyTimeout: MODEL_REQUEST_TIMEOUT_MS }, handler);
  }
}

declare global {
  var __readaloudModelAgent: ModelAgent | undefined;
}

export function getModelAgent(): ModelAgent {
  // 热更新复用连接池；已关闭的测试/服务实例可重新创建。
  const current = globalThis.__readaloudModelAgent;
  if (!current || current.closed || current.destroyed) globalThis.__readaloudModelAgent = new ModelAgent();
  return globalThis.__readaloudModelAgent!;
}

export function modelFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const options: RequestInit & { dispatcher: Dispatcher } = { ...init, dispatcher: getModelAgent() };
  return fetch(input, options);
}
