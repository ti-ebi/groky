import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { workspaceName } from "./shared/path";

type WorkspaceFileKind = "directory" | "file" | "symlink";
type DirectoryStatus = "loading" | "ready" | "error";
type WorkspacePreviewKind = "font" | "image" | "pdf" | "text" | "unsupported";

const DEFAULT_PREVIEW_WIDTH_RATIO = 0.62;
const MIN_PREVIEW_PANE_WIDTH = 190;
const MIN_FILE_TREE_WIDTH = 132;
const FILE_EXPLORER_DIVIDER_WIDTH = 7;

function maximumPreviewPaneWidth(containerWidth: number) {
  return Math.max(
    MIN_PREVIEW_PANE_WIDTH,
    containerWidth - MIN_FILE_TREE_WIDTH - FILE_EXPLORER_DIVIDER_WIDTH,
  );
}

function clampPreviewPaneWidth(width: number, containerWidth: number) {
  return Math.min(
    maximumPreviewPaneWidth(containerWidth),
    Math.max(MIN_PREVIEW_PANE_WIDTH, width),
  );
}

function defaultPreviewPaneWidth(containerWidth: number) {
  return clampPreviewPaneWidth(containerWidth * DEFAULT_PREVIEW_WIDTH_RATIO, containerWidth);
}

interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  size: number | null;
  modifiedAt: number | null;
  hidden: boolean;
}

interface WorkspaceDirectoryListing {
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

interface DirectoryState {
  status: DirectoryStatus;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
  error?: string;
}

interface WorkspaceChangedEvent {
  sessionId: string;
  paths: string[];
}

interface WorkspaceFilePreview {
  path: string;
  name: string;
  kind: WorkspacePreviewKind;
  mimeType: string | null;
  size: number;
  content: string | null;
  dataUrl: string | null;
  truncated: boolean;
}

type FilePreviewState =
  | { status: "loading"; entry: WorkspaceFileEntry }
  | { status: "ready"; entry: WorkspaceFileEntry; preview: WorkspaceFilePreview }
  | { status: "error"; entry: WorkspaceFileEntry; error: string };

export interface WorkspaceFileAttachment {
  path: string;
  name: string;
  size: number;
  mimeType?: string | null;
}

interface VisibleFileRow {
  entry: WorkspaceFileEntry;
  depth: number;
}

type ExplorerIconName =
  | "chevron"
  | "code"
  | "eye"
  | "eye-off"
  | "file"
  | "folder"
  | "folder-open"
  | "image"
  | "link"
  | "open"
  | "paperclip"
  | "settings";

function ExplorerIcon({ name, size = 15 }: { name: ExplorerIconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "chevron" && <path d="m9 6 6 6-6 6" />}
      {name === "code" && <><path d="m9 8-4 4 4 4" /><path d="m15 8 4 4-4 4" /></>}
      {name === "eye" && <><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></>}
      {name === "eye-off" && <><path d="m4 4 16 16" /><path d="M10.6 6.2A9 9 0 0 1 12 6c6.1 0 9.5 6 9.5 6a13 13 0 0 1-2.1 2.8M6.2 7.2C3.8 9 2.5 12 2.5 12s3.4 6 9.5 6a9 9 0 0 0 3.1-.5" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>}
      {name === "file" && <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v5h5" /></>}
      {name === "folder" && <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
      {name === "folder-open" && <><path d="M3 9V7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1" /><path d="m3 10 2 9h14l2-9Z" /></>}
      {name === "image" && <><rect x="4" y="4" width="16" height="16" rx="2" /><circle cx="9" cy="9" r="1.5" /><path d="m5 17 4-4 3 3 2-2 5 4" /></>}
      {name === "link" && <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" /></>}
      {name === "open" && <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>}
      {name === "paperclip" && <path d="m20 11.5-8.6 8.6a5 5 0 0 1-7-7l9.3-9.3a3.5 3.5 0 1 1 5 5l-8.7 8.7a2 2 0 0 1-2.8-2.8l8-8" />}
      {name === "settings" && <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>}
    </svg>
  );
}

function fileVisualKind(entry: WorkspaceFileEntry) {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "symlink") return "link";
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"].includes(extension)) return "image";
  if (["c", "cpp", "css", "go", "html", "java", "js", "jsx", "json", "md", "py", "rs", "sh", "sql", "toml", "ts", "tsx", "vue", "yaml", "yml"].includes(extension)) return "code";
  if (["env", "ini", "lock", "properties", "xml"].includes(extension) || entry.name.startsWith(".")) return "settings";
  return "file";
}

function fileIconName(entry: WorkspaceFileEntry, expanded: boolean): ExplorerIconName {
  const visualKind = fileVisualKind(entry);
  if (visualKind === "folder") return expanded ? "folder-open" : "folder";
  return visualKind;
}

function parentPath(path: string) {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function directoryMatchesListing(
  directory: DirectoryState,
  listing: WorkspaceDirectoryListing,
) {
  return directory.status === "ready"
    && directory.truncated === listing.truncated
    && directory.entries.length === listing.entries.length
    && directory.entries.every((entry, index) => {
      const next = listing.entries[index];
      return next !== undefined
        && entry.name === next.name
        && entry.path === next.path
        && entry.kind === next.kind
        && entry.size === next.size
        && entry.modifiedAt === next.modifiedAt
        && entry.hidden === next.hidden;
    });
}

function formatFileSize(bytes: number | null) {
  if (bytes === null) return "";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
}

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
  const worker = new Worker(new URL("./syntaxHighlight.worker.ts", import.meta.url), { type: "module" });
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
    void invoke<WorkspaceFilePreview>("workspace_preview_file", { sessionId, path })
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

function FilePreviewPane({
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
          {previewSize !== null && <small>{formatFileSize(previewSize)}</small>}
        </div>
      </footer>
    </aside>
  );
}

export function FileExplorer({
  active,
  sessionId,
  workingDirectory,
  attachmentDisabled,
  onAttach,
}: {
  active: boolean;
  sessionId: string | null;
  workingDirectory: string | null;
  attachmentDisabled: boolean;
  onAttach: (attachment: WorkspaceFileAttachment) => boolean;
}) {
  const directoryRef = useRef<Record<string, DirectoryState>>({});
  const loadingPaths = useRef<Set<string>>(new Set());
  const requestGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const previewStateRef = useRef<FilePreviewState | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const splitPaneRef = useRef<HTMLDivElement>(null);
  const splitResizeStart = useRef<{ pointerX: number; previewWidth: number } | null>(null);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [attachingPath, setAttachingPath] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<FilePreviewState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [splitPaneWidth, setSplitPaneWidth] = useState(0);
  const [previewPaneWidth, setPreviewPaneWidth] = useState<number | null>(null);

  useEffect(() => {
    const splitPane = splitPaneRef.current;
    if (!splitPane) return;

    const updateWidth = () => {
      const width = splitPane.clientWidth;
      if (width <= 0) return;
      setSplitPaneWidth(width);
      setPreviewPaneWidth((current) => (
        current === null
          ? defaultPreviewPaneWidth(width)
          : clampPreviewPaneWidth(current, width)
      ));
    };

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(splitPane);
    updateWidth();
    return () => resizeObserver.disconnect();
  }, [sessionId]);

  useEffect(() => () => {
    document.body.classList.remove("is-resizing-file-preview");
  }, []);

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  const commitDirectories = useCallback((
    update: (current: Record<string, DirectoryState>) => Record<string, DirectoryState>,
  ) => {
    setDirectories((current) => {
      const next = update(current);
      directoryRef.current = next;
      return next;
    });
  }, []);

  const loadDirectory = useCallback(async (path: string, force = false, background = false) => {
    if (!sessionId || loadingPaths.current.has(path)) return;
    if (!force && directoryRef.current[path]?.status === "ready") return;

    const generation = requestGeneration.current;
    loadingPaths.current.add(path);
    if (!background || directoryRef.current[path]?.status !== "ready") {
      commitDirectories((current) => ({
        ...current,
        [path]: {
          entries: current[path]?.entries ?? [],
          truncated: current[path]?.truncated ?? false,
          status: "loading",
        },
      }));
    }

    try {
      const listing = await invoke<WorkspaceDirectoryListing>("workspace_list_directory", {
        sessionId,
        path,
      });
      if (generation !== requestGeneration.current) return;
      commitDirectories((current) => {
        const previous = current[path];
        if (previous && directoryMatchesListing(previous, listing)) return current;
        return {
          ...current,
          [path]: {
          entries: listing.entries,
          truncated: listing.truncated,
          status: "ready",
          },
        };
      });
    } catch (error) {
      if (generation !== requestGeneration.current) return;
      commitDirectories((current) => {
        if (background && current[path]?.status === "ready") return current;
        return {
          ...current,
          [path]: {
          entries: current[path]?.entries ?? [],
          truncated: false,
          status: "error",
          error: String(error),
          },
        };
      });
    } finally {
      loadingPaths.current.delete(path);
    }
  }, [commitDirectories, sessionId]);

  useEffect(() => {
    requestGeneration.current += 1;
    previewGeneration.current += 1;
    loadingPaths.current.clear();
    directoryRef.current = {};
    setDirectories({});
    setExpanded(new Set());
    setSelectedPath(null);
    setAttachingPath(null);
    setOpeningFolder(false);
    setPreviewState(null);
    setNotice(null);
  }, [sessionId]);

  useEffect(() => {
    if (active && sessionId) void loadDirectory("");
  }, [active, loadDirectory, sessionId]);

  const rows = useMemo(() => {
    const visibleRows: VisibleFileRow[] = [];
    const appendDirectory = (path: string, depth: number) => {
      const directory = directories[path];
      if (!directory) return;
      directory.entries.forEach((entry) => {
        if (!showHidden && entry.hidden) return;
        visibleRows.push({ entry, depth });
        if (entry.kind === "directory" && expanded.has(entry.path)) {
          appendDirectory(entry.path, depth + 1);
        }
      });
    };
    appendDirectory("", 0);
    return visibleRows;
  }, [directories, expanded, showHidden]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !rows.some(({ entry }) => entry.path === selectedPath)) {
      setSelectedPath(rows[0].entry.path);
    }
  }, [rows, selectedPath]);

  const selectedEntry = rows.find(({ entry }) => entry.path === selectedPath)?.entry ?? null;
  const folderToOpen = selectedEntry
    ? selectedEntry.kind === "directory" ? selectedEntry.path : parentPath(selectedEntry.path)
    : "";
  const openFolderLabel = selectedEntry
    ? selectedEntry.kind === "directory"
      ? `Open ${selectedEntry.name} in file manager`
      : `Open folder containing ${selectedEntry.name}`
    : "Open workspace folder in file manager";
  const rootState = directories[""];
  const hasTruncatedDirectory = Object.values(directories).some((directory) => directory.truncated);

  function focusRow(path: string) {
    setSelectedPath(path);
    window.requestAnimationFrame(() => rowRefs.current.get(path)?.focus());
  }

  function toggleDirectory(entry: WorkspaceFileEntry) {
    if (entry.kind !== "directory") return;
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(entry.path));
    void loadDirectory(entry.path);
  }

  const previewFile = useCallback(async (entry: WorkspaceFileEntry, background = false) => {
    if (!sessionId || entry.kind === "directory") return;
    const generation = ++previewGeneration.current;
    setSelectedPath(entry.path);
    if (!background) setPreviewState({ status: "loading", entry });
    try {
      const preview = await invoke<WorkspaceFilePreview>("workspace_preview_file", {
        sessionId,
        path: entry.path,
      });
      if (generation === previewGeneration.current) {
        setPreviewState({ status: "ready", entry, preview });
      }
    } catch (error) {
      if (generation === previewGeneration.current) {
        setPreviewState({ status: "error", entry, error: String(error) });
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!active || !sessionId) return;

    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let refreshTimer = 0;
    let refreshAll = false;
    const changedPaths = new Set<string>();
    const watchId = crypto.randomUUID();

    const refreshLoadedDirectories = (paths: string[]) => {
      const loadedDirectories = directoryRef.current;
      const directoriesToRefresh = new Set<string>();
      if (paths.length === 0) {
        Object.keys(loadedDirectories).forEach((path) => directoriesToRefresh.add(path));
      } else {
        paths.forEach((changedPath) => {
          if (loadedDirectories[changedPath]) directoriesToRefresh.add(changedPath);
          let directory = parentPath(changedPath);
          while (true) {
            if (loadedDirectories[directory]) {
              directoriesToRefresh.add(directory);
              break;
            }
            if (!directory) break;
            directory = parentPath(directory);
          }
        });
      }
      directoriesToRefresh.forEach((path) => void loadDirectory(path, true, true));

      const previewEntry = previewStateRef.current?.entry;
      if (previewEntry && (paths.length === 0 || paths.includes(previewEntry.path))) {
        void previewFile(previewEntry, true);
      }
    };

    const scheduleRefresh = (paths: string[]) => {
      if (paths.length === 0) refreshAll = true;
      paths.forEach((path) => changedPaths.add(path));
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const pathsToRefresh = refreshAll ? [] : Array.from(changedPaths);
        refreshAll = false;
        changedPaths.clear();
        refreshLoadedDirectories(pathsToRefresh);
      }, 140);
    };

    void listen<WorkspaceChangedEvent>("groky://workspace-changed", ({ payload }) => {
      if (payload.sessionId === sessionId) scheduleRefresh(payload.paths);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    });
    void invoke("workspace_watch", { sessionId, watchId }).catch(() => undefined);

    const reconciliationTimer = window.setInterval(() => scheduleRefresh([]), 15_000);
    return () => {
      disposed = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      unlisten?.();
      void invoke("workspace_unwatch", { sessionId, watchId }).catch(() => undefined);
    };
  }, [active, loadDirectory, previewFile, sessionId]);

  function activateEntry(entry: WorkspaceFileEntry) {
    setSelectedPath(entry.path);
    if (entry.kind === "directory") {
      toggleDirectory(entry);
    } else {
      void previewFile(entry);
    }
  }

  async function openSelectedFolder() {
    if (!sessionId || openingFolder) return;
    setOpeningFolder(true);
    setNotice(null);
    try {
      await invoke("workspace_open_folder", { sessionId, path: folderToOpen });
      setNotice(selectedEntry && selectedEntry.kind !== "directory"
        ? `Opened the folder containing ${selectedEntry.name}.`
        : "Opened the selected folder in the system file manager.");
    } catch (error) {
      setNotice(String(error));
    } finally {
      setOpeningFolder(false);
    }
  }

  async function attachFile(entry: WorkspaceFileEntry) {
    if (!sessionId || entry.kind !== "file" || attachmentDisabled || attachingPath) return;
    const generation = requestGeneration.current;
    setAttachingPath(entry.path);
    setNotice(null);
    try {
      const attachment = await invoke<WorkspaceFileAttachment>("workspace_inspect_attachment", {
        sessionId,
        path: entry.path,
      });
      if (generation !== requestGeneration.current) return;
      const added = onAttach(attachment);
      setNotice(added ? `${entry.name} attached to the next message.` : `${entry.name} is already attached.`);
    } catch (error) {
      if (generation === requestGeneration.current) setNotice(String(error));
    } finally {
      if (generation === requestGeneration.current) setAttachingPath(null);
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLDivElement>, row: VisibleFileRow, index: number) {
    const { entry } = row;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const nextRow = rows[Math.min(rows.length - 1, Math.max(0, index + offset))];
      if (nextRow) focusRow(nextRow.entry.path);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextRow = event.key === "Home" ? rows[0] : rows[rows.length - 1];
      if (nextRow) focusRow(nextRow.entry.path);
      return;
    }
    if (event.key === "ArrowRight" && entry.kind === "directory") {
      event.preventDefault();
      if (!expanded.has(entry.path)) {
        toggleDirectory(entry);
      } else {
        const child = rows[index + 1];
        if (child && child.depth > row.depth) focusRow(child.entry.path);
      }
      return;
    }
    if (event.key === "ArrowLeft") {
      if (entry.kind === "directory" && expanded.has(entry.path)) {
        event.preventDefault();
        toggleDirectory(entry);
        return;
      }
      const parent = parentPath(entry.path);
      const parentRow = rows.find(({ entry: candidate }) => candidate.path === parent);
      if (parentRow) {
        event.preventDefault();
        focusRow(parentRow.entry.path);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateEntry(entry);
    }
  }

  function currentSplitPaneWidth() {
    return splitPaneRef.current?.clientWidth || splitPaneWidth;
  }

  function effectivePreviewPaneWidth() {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return MIN_PREVIEW_PANE_WIDTH;
    return clampPreviewPaneWidth(
      previewPaneWidth ?? defaultPreviewPaneWidth(containerWidth),
      containerWidth,
    );
  }

  function startSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    splitResizeStart.current = {
      pointerX: event.clientX,
      previewWidth: effectivePreviewPaneWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing-file-preview");
  }

  function resizeSplit(event: ReactPointerEvent<HTMLDivElement>) {
    const start = splitResizeStart.current;
    if (!start) return;
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return;
    setPreviewPaneWidth(clampPreviewPaneWidth(
      start.previewWidth + event.clientX - start.pointerX,
      containerWidth,
    ));
  }

  function finishSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!splitResizeStart.current) return;
    splitResizeStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-file-preview");
  }

  function resizeSplitWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth <= 0) return;
    const step = event.shiftKey ? 32 : 12;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = effectivePreviewPaneWidth() - step;
    if (event.key === "ArrowRight") nextWidth = effectivePreviewPaneWidth() + step;
    if (event.key === "Home") nextWidth = MIN_PREVIEW_PANE_WIDTH;
    if (event.key === "End") nextWidth = maximumPreviewPaneWidth(containerWidth);
    if (nextWidth === null) return;
    event.preventDefault();
    setPreviewPaneWidth(clampPreviewPaneWidth(nextWidth, containerWidth));
  }

  function resetSplitWidth() {
    const containerWidth = currentSplitPaneWidth();
    if (containerWidth > 0) setPreviewPaneWidth(defaultPreviewPaneWidth(containerWidth));
  }

  if (!sessionId) {
    return (
      <div className="file-explorer-unavailable" role="status">
        <span className="file-explorer-unavailable-icon"><ExplorerIcon name="folder" size={18} /></span>
        <strong>Files become available with a session</strong>
        <p>Start or reopen a Grok session to browse its working directory.</p>
      </div>
    );
  }

  return (
    <section className="file-explorer" aria-label="Workspace files">
      <div
        className="file-explorer-body"
        ref={splitPaneRef}
        style={{
          "--file-preview-width": previewPaneWidth === null
            ? `${DEFAULT_PREVIEW_WIDTH_RATIO * 100}%`
            : `${previewPaneWidth}px`,
        } as React.CSSProperties}
      >
        <div className="file-explorer-browser">
      <header className="file-explorer-header">
        <div className="file-explorer-heading" title={workingDirectory ?? undefined}>
          <span>WORKSPACE</span>
          <strong>{workspaceName(workingDirectory, "Workspace")}</strong>
        </div>
        <div className="file-explorer-actions">
          <button
            type="button"
            aria-label={openFolderLabel}
            title={openFolderLabel}
            disabled={openingFolder}
            onClick={() => void openSelectedFolder()}
          >
            <ExplorerIcon name="open" size={14} />
          </button>
          <button
            type="button"
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => setShowHidden((current) => !current)}
          >
            <ExplorerIcon name={showHidden ? "eye" : "eye-off"} size={14} />
          </button>
        </div>
      </header>

      <div className="file-explorer-tree-wrap">
        {(!rootState || rootState.status === "loading") && (
          <div className="file-tree-loading" role="status" aria-live="polite">
            {[0, 1, 2, 3, 4, 5].map((index) => <span key={index} style={{ width: `${56 + ((index * 17) % 31)}%` }} />)}
            <small>Reading workspace…</small>
          </div>
        )}
        {rootState?.status === "error" && (
          <div className="file-tree-error" role="alert">
            <span><ExplorerIcon name="folder" size={17} /></span>
            <strong>Could not read this workspace</strong>
            <p>{rootState.error}</p>
            <button type="button" onClick={() => void loadDirectory("", true)}>Try again</button>
          </div>
        )}
        {rootState?.status === "ready" && rows.length === 0 && (
          <div className="file-tree-empty" role="status">
            <span><ExplorerIcon name="folder-open" size={18} /></span>
            <strong>{rootState.entries.length === 0 ? "This folder is empty" : "Hidden files are filtered"}</strong>
            <p>{rootState.entries.length === 0 ? "New files will appear here automatically." : "Show hidden files to see this workspace."}</p>
          </div>
        )}
        {rootState?.status === "ready" && rows.length > 0 && (
          <div
            className="file-tree"
            role="tree"
            aria-label={`${workspaceName(workingDirectory, "Workspace")} files`}
          >
            {rows.map((row, index) => {
              const { entry, depth } = row;
              const selected = selectedPath === entry.path;
              const isExpanded = entry.kind === "directory" && expanded.has(entry.path);
              const directoryState = entry.kind === "directory" ? directories[entry.path] : undefined;
              const loading = directoryState?.status === "loading";
              return (
                <div
                  className="file-tree-row"
                  data-file-kind={fileVisualKind(entry)}
                  data-loading={loading || undefined}
                  data-selected={selected}
                  key={entry.path}
                  ref={(element) => {
                    if (element) rowRefs.current.set(entry.path, element);
                    else rowRefs.current.delete(entry.path);
                  }}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={selected}
                  aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
                  tabIndex={selected ? 0 : -1}
                  title={entry.path}
                  style={{ "--file-depth": depth } as React.CSSProperties}
                  onClick={(event) => {
                    if (event.detail > 1) return;
                    activateEntry(entry);
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, row, index)}
                >
                  <span className={`file-tree-chevron ${isExpanded ? "expanded" : ""}`} aria-hidden="true">
                    {entry.kind === "directory" && <ExplorerIcon name="chevron" size={12} />}
                  </span>
                  <span className="file-tree-kind-icon">
                    <ExplorerIcon name={fileIconName(entry, isExpanded)} size={15} />
                  </span>
                  <span className="file-tree-name">{entry.name}</span>
                  {entry.kind === "file" && (
                    <button
                      className="file-tree-attach"
                      type="button"
                      aria-label={`Attach ${entry.name}`}
                      title="Attach to next message"
                      disabled={attachmentDisabled || attachingPath !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        void attachFile(entry);
                      }}
                    >
                      <ExplorerIcon name="paperclip" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="file-explorer-footer">
        <div className="file-explorer-selection" title={selectedEntry?.path}>
          {selectedEntry ? (
            <>
              <span className="file-explorer-selection-icon" data-file-kind={fileVisualKind(selectedEntry)}>
                <ExplorerIcon name={fileIconName(selectedEntry, expanded.has(selectedEntry.path))} size={13} />
              </span>
              <span>{selectedEntry.path}</span>
              {selectedEntry.kind === "file" && <small>{formatFileSize(selectedEntry.size)}</small>}
            </>
          ) : <span>No file selected</span>}
        </div>
        {hasTruncatedDirectory && <span className="file-explorer-limit">5,000 item limit</span>}
      </footer>
        </div>
        <div
          className="file-explorer-divider"
          role="separator"
          aria-label="Resize file preview and file tree"
          aria-orientation="vertical"
          aria-valuemin={MIN_PREVIEW_PANE_WIDTH}
          aria-valuemax={Math.round(maximumPreviewPaneWidth(splitPaneWidth))}
          aria-valuenow={Math.round(effectivePreviewPaneWidth())}
          aria-valuetext={splitPaneWidth > 0
            ? `Preview ${Math.round(effectivePreviewPaneWidth() / splitPaneWidth * 100)} percent`
            : undefined}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
          onDoubleClick={resetSplitWidth}
          onKeyDown={resizeSplitWithKeyboard}
          onPointerDown={startSplitResize}
          onPointerMove={resizeSplit}
          onPointerUp={finishSplitResize}
          onPointerCancel={finishSplitResize}
        />
        <FilePreviewPane
          state={previewState}
          sessionId={sessionId}
          attachmentDisabled={attachmentDisabled}
          attaching={attachingPath === previewState?.entry.path}
          onAttach={(entry) => void attachFile(entry)}
        />
      </div>
      <div className="file-explorer-announcer" aria-live="polite">
        {attachingPath ? "Attaching file…" : notice}
      </div>
    </section>
  );
}
