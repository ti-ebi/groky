import {
  isValidElement,
  memo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyToClipboard } from "./shared/clipboard";
import { Icon } from "./ui/Icon";

type MarkdownCodeProps = {
  children?: ReactNode;
  className?: string;
};

function CopyableCodeBlock({ children }: { children: ReactNode }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<number | null>(null);
  const codeElement = isValidElement<MarkdownCodeProps>(children) ? children : null;
  const code = typeof codeElement?.props.children === "string"
    ? codeElement.props.children
    : null;
  const language = codeElement?.props.className?.match(/(?:^|\s)language-([^\s]+)/)?.[1];
  const copyText = code?.replace(/\n$/, "") ?? "";
  const copyLabel = copyState === "copied"
    ? "Code copied"
    : copyState === "error"
      ? "Retry copying code"
      : "Copy code";

  useEffect(() => {
    setCopyState("idle");
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);

    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, [copyText]);

  if (code === null) return <pre>{children}</pre>;

  async function copyCode() {
    try {
      await copyToClipboard(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 2_200);
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{language ?? "code"}</span>
        <button
          className={`markdown-code-copy ${copyState}`}
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copyCode()}
        >
          <Icon name={copyState === "copied" ? "check" : "copy"} size={12} />
          <span className="markdown-code-copy-status" aria-live="polite">
            {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : ""}
          </span>
        </button>
      </div>
      <pre><code className={codeElement?.props.className}>{code}</code></pre>
    </div>
  );
}

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
        pre: ({ children: codeBlock }) => (
          <CopyableCodeBlock>{codeBlock}</CopyableCodeBlock>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
});
