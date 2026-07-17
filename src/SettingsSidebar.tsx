import { Icon } from "./Icon";
import { SETTINGS_SECTIONS, type SettingsSection } from "./settings";

export function SettingsSidebar({
  overlayTitlebar,
  section,
  onSectionChange,
  onBack,
}: {
  overlayTitlebar: boolean;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
}) {
  return (
    <aside className="sidebar settings-sidebar">
      <div className="window-nav settings-window-nav" {...(overlayTitlebar ? { "data-tauri-drag-region": "deep" } : {})}>
        <button className="settings-return" type="button" onClick={onBack}>
          <Icon name="arrow-right" size={15} />
          <span>Back to Groky</span>
        </button>
      </div>

      <div className="settings-sidebar-heading">
        <h2>Settings</h2>
      </div>

      <nav className="settings-sidebar-nav" aria-label="Settings">
        {SETTINGS_SECTIONS.map((option) => (
          <button
            className={section === option.id ? "active" : ""}
            type="button"
            aria-current={section === option.id ? "page" : undefined}
            key={option.id}
            onClick={() => onSectionChange(option.id)}
          >
            <span className="settings-nav-label">{option.label}</span>
            <Icon name="arrow-right" size={12} />
          </button>
        ))}
      </nav>

      <div className="settings-sidebar-footer">
        <span className="avatar">G</span>
        <span><strong>Grok Build</strong><small>Signed in via the local CLI</small></span>
      </div>
    </aside>
  );
}
