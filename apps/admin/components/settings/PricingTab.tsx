"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api-client";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import type { PricingDefaults } from "./types";

interface FormState {
  domestic: string;
  intl: string;
  marginPercent: string;
}

function toFormState(d: PricingDefaults): FormState {
  return {
    domestic: d.defaultShippingCostJpyDomestic != null ? String(d.defaultShippingCostJpyDomestic) : "",
    intl: d.defaultShippingCostJpyIntl != null ? String(d.defaultShippingCostJpyIntl) : "",
    marginPercent: d.defaultTargetMarginBasisPoints != null ? String(d.defaultTargetMarginBasisPoints / 100) : "",
  };
}

export default function PricingTab() {
  const { notify } = useToast();
  const [defaults, setDefaults] = useState<PricingDefaults | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiGet<PricingDefaults>("/admin/tenant/pricing-defaults")
      .then((res) => {
        setDefaults(res);
        setForm(toFormState(res));
      })
      .catch((err) => notify(`価格設定の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const body = {
        defaultShippingCostJpyDomestic: form.domestic.trim() === "" ? null : Number(form.domestic),
        defaultShippingCostJpyIntl: form.intl.trim() === "" ? null : Number(form.intl),
        defaultTargetMarginPercent: form.marginPercent.trim() === "" ? null : Number(form.marginPercent),
      };
      const updated = await apiPatch<PricingDefaults>("/admin/tenant/pricing-defaults", body);
      setDefaults(updated);
      setForm(toFormState(updated));
      notify("価格設定のデフォルト値を更新しました。", "success");
    } catch (err) {
      notify(`価格設定の更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="card card-pad">読み込み中...</div>;
  if (!defaults || !form) return null;

  return (
    <div className="settings-grid">
      <Card>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>価格設定のデフォルト値</h2>
        <p style={{ fontSize: "0.8rem", color: "var(--fg-subtle)", margin: "0 0 0.9rem" }}>
          商品ごとに個別設定がある場合はそちらが優先されます。ここで設定した値は、個別設定のない商品にのみ適用されます。
        </p>
        <label className="settings-field">
          国内配送料(円)
          <input
            type="number"
            min={0}
            value={form.domestic}
            onChange={(e) => setForm({ ...form, domestic: e.target.value })}
            placeholder="未設定(プラットフォーム既定値を使用)"
          />
        </label>
        <label className="settings-field">
          海外配送料(円)
          <input
            type="number"
            min={0}
            value={form.intl}
            onChange={(e) => setForm({ ...form, intl: e.target.value })}
            placeholder="未設定(プラットフォーム既定値を使用)"
          />
        </label>
        <label className="settings-field">
          目標利益率(%)
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={form.marginPercent}
            onChange={(e) => setForm({ ...form, marginPercent: e.target.value })}
            placeholder="未設定(プラットフォーム既定値を使用)"
          />
        </label>
        <div className="settings-form-actions">
          <button type="button" onClick={save} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </Card>

      <Card>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>為替レート</h2>
        <p style={{ fontSize: "0.85rem", margin: 0 }}>USD/JPYの為替レートは外部APIから自動取得され、価格計算に反映されます。</p>
        <p className="settings-disabled-note">
          現在は自動取得モードのみ提供しています。手動レート設定・固定レートモードは未提供です。
        </p>
      </Card>
    </div>
  );
}
