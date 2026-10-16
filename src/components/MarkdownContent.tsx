import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
import { normalizeMathDelimiters } from "@/lib/markdown/math";

const remarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const rehypePlugins: PluggableList = [[rehypeKatex, { trust: false, strict: "warn" }]];

/** Shared by draft previews and saved reading blocks; normalization is display-only. */
export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
    {normalizeMathDelimiters(children)}
  </ReactMarkdown>;
});
