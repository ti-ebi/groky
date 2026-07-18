import { useEffect, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { host } from "../host";
import type { WorkspaceFileEntry, WorkspaceFilePreview } from "../host/types";
import {
  ExplorerIcon,
  fileIconName,
  fileVisualKind,
  formatWorkspaceFileSize,
  parentPath,
} from "./fileVisuals";

export type FilePreviewState =
  | { status: "loading"; entry: WorkspaceFileEntry }
  | { status: "ready"; entry: WorkspaceFileEntry; preview: WorkspaceFilePreview }
  | { status: "error"; entry: WorkspaceFileEntry; error: string };

function previewDescription(preview: WorkspaceFilePreview) {
  if (preview.kind === "text") {
    const lineCount = (preview.content?.match(/\n/g)?.length ?? 0) + 1;
    return `${lineCount.toLocaleString()} ${lineCount === 1 ? "line" : "lines"}`;
  }
  return preview.mimeType ?? "Unknown format";
}

function unsupportedPreviewMessage(preview: WorkspaceFilePreview) {
  if (preview.mimeType?.startsWith("audio/")) return "Audio preview is not supported.";
  if (preview.mimeType?.startsWith("video/")) return "Video preview is not supported.";
  if (preview.truncated) return "This file is too large for an in-app preview.";
  return "You can still attach this file to your next message.";
}

interface SyntaxHighlightWorkerResponse {
  id: number;
  html?: string;
  language?: string;
  error?: string;
}

interface SyntaxHighlightResult {
  html: string;
  language: string;
}

let syntaxHighlightWorker: Worker | null = null;
let syntaxHighlightRequestId = 0;
const syntaxHighlightRequests = new Map<
  number,
  { resolve: (result: SyntaxHighlightResult) => void; reject: (error: Error) => void }
>();

function getSyntaxHighlightWorker() {
  if (syntaxHighlightWorker) return syntaxHighlightWorker;
  const worker = new Worker(new URL("../syntaxHighlight.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<SyntaxHighlightWorkerResponse>) => {
    const request = syntaxHighlightRequests.get(event.data.id);
    if (!request) return;
    syntaxHighlightRequests.delete(event.data.id);
    if (event.data.error || event.data.html === undefined) {
      request.reject(new Error(event.data.error ?? "Syntax highlighting failed."));
      return;
    }
    request.resolve({
      html: event.data.html,
      language: event.data.language ?? "plaintext",
    });
  });
  worker.addEventListener("error", () => {
    syntaxHighlightRequests.forEach(({ reject }) => reject(new Error("Syntax highlighting failed.")));
    syntaxHighlightRequests.clear();
    worker.terminate();
    if (syntaxHighlightWorker === worker) syntaxHighlightWorker = null;
  });
  syntaxHighlightWorker = worker;
  return worker;
}

function requestSyntaxHighlight(code: string, language: string | null) {
  const id = ++syntaxHighlightRequestId;
  const promise = new Promise<SyntaxHighlightResult>((resolve, reject) => {
    syntaxHighlightRequests.set(id, { resolve, reject });
  });
  getSyntaxHighlightWorker().postMessage({ id, code, language });
  return promise;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  astro: "xml",
  bash: "bash",
  c: "c",
  cc: "cpp",
  clj: "clojure",
  cljs: "clojure",
  cmake: "cmake",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  diff: "diff",
  dockerfile: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  fs: "fsharp",
  fsx: "fsharp",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  h: "c",
  hpp: "cpp",
  hs: "haskell",
  htm: "xml",
  html: "xml",
  http: "http",
  ini: "ini",
  java: "java",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  json5: "json",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  m: "objectivec",
  mjs: "javascript",
  mm: "objectivec",
  php: "php",
  pl: "perl",
  pm: "perl",
  ps1: "powershell",
  py: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sass: "scss",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  vue: "xml",
  wasm: "wasm",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

function fileExtension(name: string) {
  const separator = name.lastIndexOf(".");
  return separator > 0 ? name.slice(separator + 1).toLowerCase() : "";
}

function isMarkdownFile(name: string) {
  return ["markdown", "md", "mdown", "mdx", "mkdn"].includes(fileExtension(name));
}

function syntaxLanguageForFile(name: string) {
  const normalizedName = name.toLowerCase();
  if (["dockerfile", "containerfile"].includes(normalizedName)) return "dockerfile";
  if (["makefile", "gnumakefile"].includes(normalizedName)) return "makefile";
  if (normalizedName === "cmakelists.txt") return "cmake";
  if (normalizedName === "cargo.lock") return "toml";
  if (normalizedName === "package-lock.json") return "json";
  if (["pnpm-lock.yaml", "yarn.lock"].includes(normalizedName)) return "yaml";
  if (normalizedName === ".env" || normalizedName.startsWith(".env.")) return "bash";
  const extension = fileExtension(normalizedName);
  if (["csv", "log", "text", "tsv", "txt"].includes(extension)) return "plaintext";
  if (normalizedName.startsWith(".")) return "plaintext";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function useSyntaxHighlight(code: string, language: string | null) {
  const [highlighted, setHighlighted] = useState<SyntaxHighlightResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setHighlighted(null);
    setFailed(false);
    void requestSyntaxHighlight(code, language)
      .then((result) => {
        if (active) setHighlighted(result);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [code, language]);

  return { failed, highlighted };
}

function SyntaxHighlightedCode({ code, name }: { code: string; name: string }) {
  const { failed, highlighted } = useSyntaxHighlight(code, syntaxLanguageForFile(name));

  return (
    <div className="file-preview-text-stage" data-highlighting={!highlighted && !failed || undefined}>
      <pre tabIndex={0}>
        {highlighted ? (
          <code
            className={`hljs language-${highlighted.language}`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        ) : <code>{code}</code>}
      </pre>
      {!highlighted && !failed && <span className="file-preview-highlighting">Highlighting…</span>}
    </div>
  );
}

function MarkdownHighlightedCode({ code, language }: { code: string; language: string }) {
  const { highlighted } = useSyntaxHighlight(code, language);
  if (!highlighted) return <code className={`language-${language}`}>{code}</code>;
  return (
    <code
      className={`hljs language-${highlighted.language}`}
      dangerouslySetInnerHTML={{ __html: highlighted.html }}
    />
  );
}

function MarkdownCode({ children, className, ...props }: ComponentProps<"code">) {
  const match = /language-([\w-]+)/.exec(className ?? "");
  if (!match) return <code className={className} {...props}>{children}</code>;
  const code = String(children).replace(/\n$/, "");
  return <MarkdownHighlightedCode code={code} language={match[1]} />;
}

function resolveMarkdownAssetPath(markdownPath: string, source: string) {
  if (!source || source.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(source)) return null;
  let decodedSource: string;
  try {
    decodedSource = decodeURIComponent(source.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  const segments = parentPath(markdownPath).split("/").filter(Boolean);
  for (const segment of decodedSource.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function WorkspaceMarkdownImage({
  alt,
  markdownPath,
  sessionId,
  source,
  title,
}: {
  alt: string;
  markdownPath: string;
  sessionId: string;
  source: string;
  title?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(source.startsWith("data:image/") ? source : null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (source.startsWith("data:image/")) {
      setDataUrl(source);
      setUnavailable(false);
      return;
    }
    const path = resolveMarkdownAssetPath(markdownPath, source);
    if (!path) {
      setDataUrl(null);
      setUnavailable(true);
      return;
    }
    let active = true;
    setDataUrl(null);
    setUnavailable(false);
    void host.workspaceFiles.preview(sessionId, path)
      .then((preview) => {
        if (!active) return;
        if (preview.kind === "image" && preview.dataUrl) setDataUrl(preview.dataUrl);
        else setUnavailable(true);
      })
      .catch(() => {
        if (active) setUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [markdownPath, sessionId, source]);

  if (dataUrl) return <img alt={alt} src={dataUrl} title={title} loading="lazy" />;
  return (
    <span className="file-preview-markdown-media" title={source}>
      {unavailable ? "Image unavailable" : "Loading image…"}{alt ? ` · ${alt}` : ""}
    </span>
  );
}

function WorkspaceMarkdown({
  children,
  path,
  sessionId,
}: {
  children: string;
  path: string;
  sessionId: string;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ children: linkText, href, title }) => href && /^(https?|mailto):/i.test(href) ? (
          <a href={href} title={title} target="_blank" rel="noopener noreferrer">{linkText}</a>
        ) : <span className="file-preview-markdown-link" title={href}>{linkText}</span>,
        code: MarkdownCode,
        img: ({ alt, src, title }) => src ? (
          <WorkspaceMarkdownImage
            alt={alt ?? ""}
            markdownPath={path}
            sessionId={sessionId}
            source={src}
            title={title}
          />
        ) : null,
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

function FontPreview({ dataUrl, name }: { dataUrl: string; name: string }) {
  const [family] = useState(() => `GrokyPreviewFont-${Math.random().toString(36).slice(2)}`);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    const previewFont = new FontFace(family, `url("${dataUrl}")`);
    void previewFont.load().then((font) => {
      if (!active) return;
      document.fonts.add(font);
      setLoaded(true);
    }).catch(() => {
      if (active) setLoaded(false);
    });
    return () => {
      active = false;
      document.fonts.delete(previewFont);
    };
  }, [dataUrl, family]);

  return (
    <div className="file-preview-font-stage" style={loaded ? { fontFamily: `"${family}"` } : undefined}>
      <small>{loaded ? name : "Loading font…"}</small>
      <strong>Aa</strong>
      <p>Sphinx of black quartz, judge my vow.</p>
      <span>ABCDEFGHIJKLMNOPQRSTUVWXYZ</span>
      <span>abcdefghijklmnopqrstuvwxyz</span>
      <span>0123456789 !?&amp;@#%$</span>
    </div>
  );
}

export function FilePreviewPane({
  state,
  sessionId,
  attachmentDisabled,
  attaching,
  onAttach,
}: {
  state: FilePreviewState | null;
  sessionId: string;
  attachmentDisabled: boolean;
  attaching: boolean;
  onAttach: (entry: WorkspaceFileEntry) => void;
}) {
  const entry = state?.entry ?? null;
  const preview = state?.status === "ready" ? state.preview : null;
  const previewSize = preview?.size ?? entry?.size ?? null;

  return (
    <aside className="file-preview-pane" aria-label={entry ? `Preview of ${entry.name}` : "File preview"}>
      <header className="file-preview-header">
        <span className="file-preview-kind" data-file-kind={entry ? fileVisualKind(entry) : "file"}>
          <ExplorerIcon name={entry ? fileIconName(entry, false) : "file"} size={16} />
        </span>
        <div className="file-preview-heading" title={entry?.path}>
          <span>PREVIEW</span>
          <strong>{entry?.name ?? "Select a file"}</strong>
        </div>
        {entry?.kind === "file" && (
          <button
            type="button"
            className="file-preview-attach"
            disabled={attachmentDisabled || attaching}
            onClick={() => onAttach(entry)}
          >
            <ExplorerIcon name="paperclip" size={13} />
            <span>{attaching ? "Attaching…" : "Attach"}</span>
          </button>
        )}
      </header>

      <div className="file-preview-content" data-preview-kind={preview?.kind} data-preview-status={state?.status}>
        {!state && (
          <div className="file-preview-message file-preview-welcome" role="status">
            <span><ExplorerIcon name="file" size={20} /></span>
            <strong>Select a file to preview</strong>
            <p>The preview stays open while you browse folders in the tree.</p>
          </div>
        )}
        {state?.status === "loading" && entry && (
          <div className="file-preview-loading" role="status" aria-live="polite">
            <span className="file-preview-loading-mark"><ExplorerIcon name={fileIconName(entry, false)} size={22} /></span>
            <strong>Preparing preview…</strong>
            <small>{entry.name}</small>
          </div>
        )}
        {state?.status === "error" && (
          <div className="file-preview-message" role="alert">
            <span><ExplorerIcon name="file" size={20} /></span>
            <strong>Preview unavailable</strong>
            <p>{state.error}</p>
          </div>
        )}
        {preview?.kind === "image" && preview.dataUrl && (
          <div className="file-preview-image-stage">
            <img src={preview.dataUrl} alt={`Preview of ${preview.name}`} />
          </div>
        )}
        {preview?.kind === "pdf" && preview.dataUrl && (
          <iframe className="file-preview-pdf-stage" src={preview.dataUrl} title={`Preview of ${preview.name}`} />
        )}
        {preview?.kind === "font" && preview.dataUrl && (
          <FontPreview dataUrl={preview.dataUrl} name={preview.name} />
        )}
        {preview?.kind === "text" && preview.content !== null && isMarkdownFile(preview.name) && (
          <article className="file-preview-markdown">
            <WorkspaceMarkdown path={preview.path} sessionId={sessionId}>{preview.content}</WorkspaceMarkdown>
          </article>
        )}
        {preview?.kind === "text" && preview.content !== null && !isMarkdownFile(preview.name) && (
          <SyntaxHighlightedCode code={preview.content} name={preview.name} />
        )}
        {preview?.kind === "unsupported" && (
          <div className="file-preview-message" role="status">
            <span><ExplorerIcon name={entry ? fileIconName(entry, false) : "file"} size={20} /></span>
            <strong>{preview.truncated ? "File is too large to preview" : "No preview available"}</strong>
            <p>{unsupportedPreviewMessage(preview)}</p>
          </div>
        )}
      </div>

      <footer className="file-preview-footer">
        <span title={entry?.path}>{entry?.path ?? "Choose a file from the tree"}</span>
        <div>
          {preview?.truncated && preview.kind === "text" && <em>First 512 KB</em>}
          {preview && <small>{previewDescription(preview)}</small>}
          {previewSize !== null && <small>{formatWorkspaceFileSize(previewSize)}</small>}
        </div>
      </footer>
    </aside>
  );
}
