/// <reference lib="webworker" />

import hljs from "highlight.js";

interface SyntaxHighlightRequest {
  id: number;
  code: string;
  language: string | null;
}

interface SyntaxHighlightResponse {
  id: number;
  html?: string;
  language?: string;
  error?: string;
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.addEventListener("message", (event: MessageEvent<SyntaxHighlightRequest>) => {
  const { id, code, language } = event.data;
  try {
    const result = language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true })
      : hljs.highlightAuto(code);
    const response: SyntaxHighlightResponse = {
      id,
      html: result.value,
      language: result.language ?? language ?? "plaintext",
    };
    workerScope.postMessage(response);
  } catch {
    workerScope.postMessage({ id, error: "Syntax highlighting failed." } satisfies SyntaxHighlightResponse);
  }
});

export {};
