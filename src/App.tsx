import "@fontsource-variable/sora/index.css";
import "./App.css";

function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="wordmark" aria-label="Groky">
          <span className="wordmark-mark">G</span>
          <span>groky</span>
          <span className="version">dev</span>
        </div>

        <button className="new-task" type="button" disabled>
          <span>＋</span>
          New task
          <kbd>⌘ N</kbd>
        </button>

        <nav aria-label="Workspace">
          <p className="section-label">Workspace</p>
          <button className="nav-item active" type="button">
            <span className="status-dot" />
            groky
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-icon">◫</span>
            Tasks
          </button>
          <button className="nav-item" type="button" disabled>
            <span className="nav-icon">⌁</span>
            Worktrees
          </button>
        </nav>

        <div className="sidebar-foot">
          <div className="connection-row">
            <span className="connection-light" />
            Grok Build not connected
          </div>
          <span className="shortcut">Setup scaffold</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="titlebar">
          <div>
            <span className="eyebrow">LOCAL PROJECT</span>
            <strong>groky</strong>
          </div>
          <div className="title-actions" aria-label="Task status">
            <span>develop</span>
            <span className="divider" />
            <span>ACP pending</span>
          </div>
        </header>

        <section className="setup-panel">
          <div className="setup-index">00</div>
          <p className="kicker">DESKTOP FOUNDATION</p>
          <h1>The workspace is ready.<br />The agent comes next.</h1>
          <p className="lede">
            Tauri, React, TypeScript, and the development workflow are in place.
            The next phase will connect this shell to <code>grok agent stdio</code>
            over ACP.
          </p>

          <div className="readiness-grid">
            <article>
              <span className="check">✓</span>
              <div>
                <strong>Desktop shell</strong>
                <p>Tauri 2 · React · Vite</p>
              </div>
            </article>
            <article>
              <span className="check">✓</span>
              <div>
                <strong>Repository policy</strong>
                <p>Public · develop-first</p>
              </div>
            </article>
            <article className="pending">
              <span className="check">→</span>
              <div>
                <strong>Grok supervisor</strong>
                <p>Planned via ACP stdio</p>
              </div>
            </article>
          </div>
        </section>

        <footer className="composer-shell">
          <div className="composer-placeholder">
            Start a Grok task after the ACP transport is connected…
          </div>
          <div className="composer-meta">
            <span>Local</span>
            <span>Normal</span>
            <span>Grok 4.5</span>
          </div>
        </footer>
      </main>

      <aside className="inspector">
        <header>
          <span>Changes</span>
          <span className="count">0</span>
        </header>
        <div className="inspector-empty">
          <span className="diff-glyph">＋<br />−</span>
          <p>File changes will appear here when an agent session is active.</p>
        </div>
      </aside>
    </div>
  );
}

export default App;
