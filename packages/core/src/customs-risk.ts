export type CustomsRiskCategory =
  | "lithium_battery"
  | "cites_restricted_material"
  | "liquid_or_food"
  | "weapon_or_replica"
  | "magnet";

export interface CustomsRiskFlag {
  category: CustomsRiskCategory;
  /** The literal keyword that matched, so the merchant can see exactly why this fired and
   *  judge for themselves whether it's a real concern for this specific item. */
  matchedKeyword: string;
  labelJa: string;
  /** Plain-language reason this category is worth a second look before listing
   *  internationally -- not a citation of specific law, since the real rule depends on the
   *  destination country, carrier, and exact item in ways this platform can't verify. */
  reasonJa: string;
}

export interface CustomsRiskInput {
  title: string;
  descriptionJa?: string | null;
  descriptionEn?: string | null;
  material?: string | null;
}

export interface CustomsRiskResult {
  flags: CustomsRiskFlag[];
  hasRisk: boolean;
}

interface CategoryDef {
  category: CustomsRiskCategory;
  labelJa: string;
  reasonJa: string;
  keywords: string[];
}

/**
 * Item requested after reviewing a competitor (Ship&co) and real eBay/forum reports of
 * sellers losing time to exactly this: a thermal printer with a lithium battery blocked from
 * shipping to Japan, watches/chargers held up over undeclared batteries, items stuck "Held by
 * import Customs". None of the researched competitor tools (Zik Analytics, Terapeak, BQool,
 * RepricerExpress, Ship&co) flag this before listing -- they all assume the seller already
 * knows an item is shippable. This is a heuristic keyword/material scan only, run against
 * this platform's own already-stored product text -- it is NOT a customs/compliance
 * determination (the real rule always depends on destination country, carrier, and the exact
 * item), and it never blocks a listing on its own; it only surfaces something for the
 * merchant to double-check, the same "AI flags, human decides" posture this platform already
 * uses everywhere else (AI never changes price/listing state without approval).
 */
const CATEGORY_DEFS: CategoryDef[] = [
  {
    category: "lithium_battery",
    labelJa: "リチウム電池・バッテリー内蔵の可能性",
    reasonJa:
      "リチウム電池は航空輸送規則上、梱包方法や数量の申告が必要になることが多く、未申告のまま発送すると配送業者に止められたり、通関で保留されることがあります。",
    keywords: [
      "リチウム",
      "lithium",
      "バッテリー",
      "battery",
      "充電式",
      "rechargeable",
      "モバイルバッテリー",
      "power bank",
      "蓄電池",
    ],
  },
  {
    category: "cites_restricted_material",
    labelJa: "ワシントン条約(CITES)対象の可能性がある素材",
    reasonJa:
      "象牙・べっ甲・一部の毛皮や希少木材などはワシントン条約で国際取引が規制されており、証明書なしでは輸出入できない場合があります。",
    keywords: [
      "象牙",
      "ivory",
      "べっ甲",
      "鼈甲",
      "tortoiseshell",
      "珊瑚",
      "coral",
      "毛皮",
      "fur",
      "紫檀",
      "黒檀",
      "rosewood",
      "ebony",
      "ワニ革",
      "crocodile leather",
      "crocodile skin",
    ],
  },
  {
    category: "liquid_or_food",
    labelJa: "液体・食品・化粧品の可能性",
    reasonJa: "液体・食品・化粧品類は漏洩対策や成分表示(MSDS等)が求められたり、国によっては輸入そのものが禁止されている場合があります。",
    keywords: ["香水", "perfume", "化粧水", "lotion", "食品", "food item", "お酒", "酒", "alcohol", "液体", "liquid"],
  },
  {
    category: "weapon_or_replica",
    labelJa: "刃物・武器・レプリカ武器の可能性",
    reasonJa: "刀剣・模造刀・ナイフ・エアガン等は輸出入規制の対象になりやすく、証明書や許可が必要な場合があります。",
    keywords: ["刀", "sword", "模造刀", "replica sword", "ナイフ", "knife", "エアガン", "airsoft gun", "replica gun", "model gun"],
  },
  {
    category: "magnet",
    labelJa: "強力磁石の可能性",
    reasonJa: "強力な磁石は航空貨物の計器に影響する恐れがあるとして、一部の配送業者・航空便で制限されることがあります。",
    keywords: ["強力磁石", "neodymium", "ネオジム磁石", "strong magnet"],
  },
];

function normalize(text: string): string {
  return text.toLowerCase();
}

/**
 * Scans this product's own already-stored title/description/material text (Japanese source
 * and, when available, the AI-generated English listing draft) for keywords associated with
 * categories that commonly cause cross-border shipping trouble. See CATEGORY_DEFS's own doc
 * comment for exactly what this is -- and isn't.
 */
export function assessCustomsRisk(input: CustomsRiskInput): CustomsRiskResult {
  const haystack = normalize(
    [input.title, input.descriptionJa ?? "", input.descriptionEn ?? "", input.material ?? ""].join(" \n "),
  );

  const flags: CustomsRiskFlag[] = [];
  for (const def of CATEGORY_DEFS) {
    for (const keyword of def.keywords) {
      if (haystack.includes(normalize(keyword))) {
        flags.push({ category: def.category, matchedKeyword: keyword, labelJa: def.labelJa, reasonJa: def.reasonJa });
        break; // one match per category is enough to warrant a look; avoid noisy duplicates.
      }
    }
  }

  return { flags, hasRisk: flags.length > 0 };
}
