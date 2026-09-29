export interface TabItem {
  id: string;
  label: string;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
}

/** On top of the existing `.filter-tabs`/`.filter-tab` classes (already used by the dashboard
 *  and products pages for their own filter row) -- same look, now available as a controlled
 *  component for content-switching tabs (e.g. the product preview drawer's 基本情報/価格・
 *  在庫/AI・同期 tabs) instead of each caller re-hand-rolling the button row. */
export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="filter-tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          className="filter-tab"
          data-active={t.id === active}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
