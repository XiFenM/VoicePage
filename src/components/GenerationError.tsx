import type { JobErrorDetail } from "@/lib/store/types";
import { jobErrorLabel } from "./generation-history";

export function GenerationError({ error, message }: { error?: JobErrorDetail; message?: string }) {
  return <div className="space-y-1.5 text-xs">
    <p className="break-words leading-5">{error && <span className="font-medium">{jobErrorLabel(error.category)}：{` `}</span>}{error?.message || message || "服务器未返回详细原因。"}</p>
    {error && <>
      {(error.code || error.httpStatus || error.requestId) && <dl className="flex flex-wrap gap-x-4 gap-y-1 break-all opacity-80">
        {error.code && <div><dt className="inline">错误码：</dt><dd className="inline font-mono">{error.code}</dd></div>}
        {error.httpStatus && <div><dt className="inline">HTTP：</dt><dd className="inline font-mono">{error.httpStatus}</dd></div>}
        {error.requestId && <div><dt className="inline">请求 ID：</dt><dd className="inline font-mono">{error.requestId}</dd></div>}
      </dl>}
      {error.causes.length > 0 && <details className="rounded border border-current/20 px-2 py-1">
        <summary className="cursor-pointer">查看底层原因（{error.causes.length}）</summary>
        <ol className="mt-2 space-y-1 break-all">{error.causes.map((cause, index) => <li key={index}>
          <span className="font-medium">{cause.name}{cause.code ? ` · ${cause.code}` : ""}</span>：{cause.message}
        </li>)}</ol>
      </details>}
    </>}
  </div>;
}
