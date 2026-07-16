import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = memo(function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children: linkText, href, title }) => (
          <a href={href} title={title} target="_blank" rel="noopener noreferrer">
            {linkText}
          </a>
        ),
        img: ({ alt, src, title }) => (
          <img alt={alt ?? ""} src={src} title={title} loading="lazy" />
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
});
