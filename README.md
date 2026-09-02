# base-ebay-sync — AI EC運営プラットフォーム

BASEに登録した商品を、AWS上の中央「商品マスター/在庫マスター」を経由してeBayへ自動出品し、価格・在庫・売却を双方向に同期するプラットフォーム。**BASEとeBayは直接通信しない** — 両者は常にAWS上のマスターを介して同期される。

```text
                 AWS Product Master / Inventory Master
                              │
                ┌─────────────┴─────────────┐
                ↓                           ↓
              BASE                        eBay
     (ChannelAdapter実装)          (ChannelAdapter実装)
```

将来Shopify/Amazon/楽天を追加する場合は `ChannelAdapter` interface (`packages/core/src/adapter.ts`) を実装するだけでよい設計。

## 現在の完成度

コード基盤・単体テスト・CDKテンプレート合成まで完了。**実AWSアカウントへのデプロイ、BASE/eBay実APIとの疎通確認は未実施**(このセッションには有効なAWS認証情報が渡されていないため)。

| 領域 | 状態 |
| --- | --- |
| モノレポ基盤 / 型定義 / Adapter抽象 | ✅ 完了・テスト済み |
| DBスキーマ(Drizzle / Aurora Postgres Data API) | ✅ 完了(実DBに対する統合テストは未実施) |
| BASE / eBay Adapter実装 | ✅ 完了・単体テスト済み(フィールド名は要・本番前に公式リファレンス突合) |
| AI生成サービス + 不確実情報ガードレール | ✅ 完了・単体テスト済み |
| Lambda同期ワーカー一式(SQS+DLQ, 冪等性, 二重販売対策) | ✅ 完了(inventory-sync-workerはロジック単体テスト済み、他はビルド確認のみ) |
| CDKインフラ一式 | ✅ 完了・`cdk synth`で8スタック全て合成成功(無認証情報でCI実行可能) |
| 管理画面(Next.js) | ✅ 完了・`next build`成功 |
| CI (lint/typecheck/build/test/cdk synth) | ✅ 完了 |
| CD (GitHub Actions OIDC, 環境保護による人間承認) | ✅ ワークフロー実装済み・要リポジトリ側の一度きりの設定 |
| 実AWSデプロイ・実BASE/eBay疎通 | ❌ 未実施(認証情報待ち) |

## P0タスク(次にやること)

1. **実AWSアカウントへの初回デプロイ**: 認証情報を受け取り次第、`cdk bootstrap` → `cdk deploy --all`。
2. **BASE/eBay開発者アプリ登録**とフィールド名の実API突合(`packages/adapters/*/src/client.ts` のコメント参照)。
3. Secrets Managerへ実クレデンシャル投入(`ai-ec-platform/app-credentials/{base,ebay,openai}`)。
4. Cognito管理者ユーザーの作成(セルフサインアップ不可のため)。
5. Amplify Hostingとこのリポジトリの接続(コンソールから、GitHub Appトークンはコードに置かない)。
6. `packages/db` のAurora実インスタンスに対するマイグレーション適用・統合テスト追加。
7. Shopify/Amazon/楽天 Adapter実装(将来タスク、`ChannelAdapter` を実装するだけ)。

## アーキテクチャ

- **フロー**: BASE商品登録 → (EventBridge定期実行)`product-fetch` Lambdaが取得・商品マスターへ保存 → SQSで`ai-generate-worker`起動 → AIがeBay向けタイトル/説明/カテゴリ/Item Specifics/価格案を生成(`ai_listing_draft`テーブル) → **管理画面で人間が承認** → `ebay-sync-worker`が実際にeBayへ出品 → BASE側の変更は`product-fetch`が検知して自動的にeBay側を更新(こちらは新規出品ではなく既承認リストの反映なので自動) → どちらかで売れたら`sales-poller`が検知 →`inventory-sync-worker`が中央在庫を0にし、もう片方のチャネルにも0を反映(在庫テーブルの楽観ロックで二重販売を防止) → 失敗はSQS再試行→DLQ→管理画面の「同期エラー」から手動再試行。
- **商品公開の人間承認**: 要件の「商品公開は人間承認必須」を満たすため、AIが生成した新規eBay出品は自動公開されない。管理画面の「承認してeBayへ出品」ボタンを押すまでeBayには一切送信されない。承認後の価格/説明の更新同期は自動。
- **AIガードレール**: `packages/ai/src/guardrail.ts` が、AIの出力に対して「ソースにない事実(ブランド/素材/サイズ)をconfirmedと主張していないか」「authenticity(真贋)をconfirmedと主張していないか(常に禁止)」をコードで強制検証する。プロンプトだけに頼らない。
- **冪等性/二重販売対策**: `packages/core/src/idempotency.ts`(DB上の一意キーによるクレーム)+ `packages/db/src/inventory.ts` の`applySale`(在庫テーブルの`version`列によるCompare-And-Swap)の二重の仕組み。
- **OAuthトークン**: DBには平文保存せず、Secrets Managerのシークレットへのポインタ(ARN)のみを保存(`oauth_connections`テーブル)。

## モノレポ構成

```text
packages/
  core/            共通ドメイン型・ChannelAdapter interface・冪等性ユーティリティ
  db/               Drizzleスキーマ・DBクライアント・在庫CAS
  adapters/base/    BASE APIアダプタ(OAuth・商品取得・在庫更新)
  adapters/ebay/    eBay APIアダプタ(OAuth・Inventory API出品・在庫更新)
  ai/               AI生成サービス + ガードレール(Bedrock/OpenAI切替可能)
services/lambdas/
  shared/           DB接続・Secrets・SQS・監査ログ等の共通ヘルパー
  oauth-base/       BASE OAuth authorize/callback
  oauth-ebay/       eBay OAuth authorize/callback
  product-fetch/    BASE商品ポーリング→商品マスター反映(EventBridge)
  ai-generate-worker/  AI生成ワーカー(SQS)
  ebay-sync-worker/    eBay出品/更新ワーカー(SQS)
  sales-poller/     BASE/eBay売却検知(EventBridge)
  inventory-sync-worker/ 在庫同期・二重販売対策(SQS)
  inventory-diff-check/  在庫差分チェック(EventBridge、日次)
  admin-api/        管理画面向けAPI(API Gateway)
infra/              AWS CDK(TypeScript)。全AWSリソース定義
apps/admin/         Next.js管理画面(Amplify Hosting)
```

## セットアップ

```bash
corepack enable
pnpm install
pnpm -r run build
pnpm -r run typecheck
pnpm -r run test
```

## デプロイ

### 1. 一度きりの人手によるブートストラップ

1. 自分のAWS認証情報で `cd infra && npx cdk deploy AiEcPlatform-dev-GithubOidc --context bootstrapOidc=true --context region=us-east-2` を一度だけ実行し、GitHub ActionsがOIDCでAssumeできるIAMロールを作成する。
2. リポジトリの Settings → Environments に `dev` と `prod` を作成し、`prod` に必須レビュアーを設定する(これが「本番デプロイは人間承認必須」のゲート)。
3. リポジトリ変数(Settings → Secrets and variables → Actions → Variables)に `AWS_DEPLOY_ROLE_ARN` / `AWS_REGION`(`us-east-2`) / `ALARM_EMAIL` を設定する。**AWSキーそのものは一切保存しない**(OIDCのみ)。
4. `cdk bootstrap`を対象アカウント/リージョンに対して実行。
5. `.github/workflows/deploy.yml` を `workflow_dispatch` から実行(environment=dev または prod)。
6. デプロイ後、Secrets Managerの `ai-ec-platform/app-credentials/{base,ebay,openai}` に実クレデンシャルを手動投入。
7. Cognitoに管理者ユーザーを作成(`aws cognito-idp admin-create-user`)。

### 2. 通常のデプロイフロー

mainへの直接pushは禁止(ブランチ保護をリポジトリ側で設定)。PRマージ後、`workflow_dispatch`で`prod`環境を指定して手動トリガー → GitHub Environmentの承認待ち → 承認後にOIDCでAWSへデプロイ。

## セキュリティ

- APIキー・OAuthトークンはGitHub/DBに平文保存しない(Secrets Manager + ARN参照のみ)。
- GitHub→AWSはOIDC(静的キーなし)。
- 各Lambdaは最小権限のIAMロール(DB Data API・該当Secrets・該当SQSキューのみ)。
- 本番デプロイ・Secrets変更・商品公開(eBay出品)は人間承認が必須な設計。
