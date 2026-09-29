import { ArrowRightIcon, BoxIcon, DatabaseIcon, TagIcon } from "@/components/icons";

/**
 * A static explainer, not a live-data widget -- the numbers are a labeled example ("例"), not
 * fetched from any product. The FORMULA it describes is real, though: calculateChannelAvailableQuantity
 * (packages/db/src/inventory.ts) withholds safety stock only from a channel that is NOT the
 * product's source channel, and inventory_master.ebay_sold_since_base_sync (a real column) is
 * the "eBay販売分" further subtracted for eBay specifically. Since almost every product in this
 * platform sources from BASE, BASE's own displayed stock is normally NOT reduced by safety
 * stock at all -- only eBay's is. That's why the example below shows BASE unaffected and only
 * eBay reduced, rather than mirroring this same "-10" step at both arrows.
 */
export function HowItWorksCard() {
  return (
    <div className="card card-pad how-it-works-card">
      <h2>在庫の仕組みと判定方法</h2>
      <div className="how-it-works-flow">
        <FlowNode icon={DatabaseIcon} title="中央在庫" subtitle="実在庫(マスター)" value="100" note="(例)" />
        <FlowEdge label="同時同期(販売・更新時)" />
        <FlowNode icon={BoxIcon} title="BASE表示在庫" subtitle="中央在庫(ソースチャネルのため safety stock は適用されません)" value="100" note="(例)" />
        <FlowEdge label="" />
        <FlowNode icon={TagIcon} title="eBay表示在庫" subtitle="中央在庫 − safety stock − eBay販売分" value="85" note="(例、safety stock 10 / eBay販売分 5)" />
      </div>

      <div className="how-it-works-legend">
        <div className="section-eyebrow">差分判定の基準</div>
        <ul>
          <li>
            <span className="badge ok">正常</span>差分 0〜2件
          </li>
          <li>
            <span className="badge warn">要確認</span>差分 3件以上(inventory-diff-checkが6時間ごとに検知)
          </li>
          <li>
            <span className="badge error">possible_double_sale</span>在庫が0になった直後に両チャネルで注文が重なった可能性
          </li>
          <li>
            <span className="badge">売り切れ</span>中央在庫が0
          </li>
        </ul>
      </div>
    </div>
  );
}

function FlowNode({ icon: Icon, title, subtitle, value, note }: { icon: typeof BoxIcon; title: string; subtitle: string; value: string; note: string }) {
  return (
    <div className="how-it-works-node">
      <div className="how-it-works-node-head">
        <Icon width={18} height={18} />
        <span>{title}</span>
      </div>
      <div className="how-it-works-node-value">{value}</div>
      <div className="how-it-works-node-subtitle">{subtitle}</div>
      <div className="how-it-works-node-note">{note}</div>
    </div>
  );
}

function FlowEdge({ label }: { label: string }) {
  return (
    <div className="how-it-works-edge">
      <ArrowRightIcon />
      {label && <span>{label}</span>}
    </div>
  );
}
