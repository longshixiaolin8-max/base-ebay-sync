import { useState } from "react";

const MAX_CHARS = 500;

interface SeoKeywordsEditorProps {
  keywords: string[];
  onChange: (keywords: string[]) => void;
}

/** Chip editor over aiListingDraft.seoKeywords (a real, already-existing column -- see
 *  POST /admin/products/{id}/draft-seo-keywords). Purely controlled: the parent page saves
 *  the value together with every other edited field on one "保存" click. */
export function SeoKeywordsEditor({ keywords, onChange }: SeoKeywordsEditorProps) {
  const [input, setInput] = useState("");
  const charCount = keywords.join(",").length;

  function addKeyword() {
    const trimmed = input.trim();
    if (!trimmed || keywords.includes(trimmed)) {
      setInput("");
      return;
    }
    onChange([...keywords, trimmed]);
    setInput("");
  }

  return (
    <div className="seo-keywords-editor">
      <div className="seo-keywords-chips">
        {keywords.map((k) => (
          <span key={k} className="seo-keyword-chip">
            {k}
            <button type="button" onClick={() => onChange(keywords.filter((x) => x !== k))} aria-label={`${k}を削除`}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="seo-keywords-input-row">
        <input
          type="text"
          value={input}
          placeholder="キーワードを追加"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addKeyword();
            }
          }}
        />
        <button type="button" className="secondary" onClick={addKeyword}>
          追加
        </button>
      </div>
      <div className="seo-keywords-count">
        {charCount} / {MAX_CHARS}
      </div>
    </div>
  );
}
