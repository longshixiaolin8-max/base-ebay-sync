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

### テナントライフサイクルとscheduled worker(解約済みテナントの扱い)

`tenants.status`(`pending_payment` / `active` / `past_due` / `canceled_grace` / `canceled`)は課金状態そのものであり、「scheduled workerが何をしてよいか」とは別の軸として扱う。理由: 支払いが止まった瞬間に同期を止めると、まだ生きているeBay/BASEの出品在庫が更新されなくなり、在庫切れなのに売れ続ける(oversell)実害が起きるため。

- `packages/db/src/tenants.ts`の`tenantSyncCapabilities(status, marketplaceOffboardedAt)`が実際の権限を決める:
  - `active` → 通常同期 + 新規商品のonboarding(AI生成含む)を許可。
  - `past_due` / `canceled_grace` → **既存**の出品の在庫同期は継続(oversell防止)、新規onboardingのみ禁止。
  - `canceled` → `marketplaceOffboardedAt`が未設定の間は`past_due`と同じ(offboarding完了を待つ)。設定済みなら何もしない。
  - `pending_payment` → 何もしない(一度も課金が有効になっていない)。
- `listWorkerEligibleTenants()`(旧`listActiveTenants` — 名前が実装(全テナント返却)と一致していなかったため改名)が`product-fetch`/`sales-poller`/`inventory-diff-check`共通のテナント一覧を返す。除外されるのは`pending_payment`と、offboarding確認済みの`canceled`のみ。
- **offboarding**: 新設の`tenant-offboarding` Lambda(EventBridge、1時間毎)が`canceled_grace`/`canceled`かつ`marketplaceOffboardedAt`未設定のテナントを対象に、公開中の`channel_listings`を`ChannelAdapter.delistProduct()`で実際にmarketplaceからdelistし、`status: "delisted"`に更新する。**全リスティングのdelistが確認できてから初めて**OAuth接続(`oauth_connections`+Secrets Managerのトークン)を削除し、`tenants.marketplaceOffboardedAt`を設定する。1つでもdelistに失敗したテナントはOAuth revoke/offboarded確定を行わず、次回実行で再試行される(在庫が生きたまま放置されない設計)。

### eBay Platform Notification abuse対策(`POST /webhooks/ebay/platform-notifications`)

このエンドポイントはeBayの旧Trading API向け配信先で、X-EBAY-SIGNATURE等の署名検証手段が一切ない(REST Notification API側の`/webhooks/ebay/notifications`とは別物)。以前は「HTTP POST 1回 = eBay poll 1回」だったため、第三者が大量POSTするとeBay API呼び出し・Lambda・DB・SQSを増幅できた。

- **エンドポイント自体に秘密トークンを埋め込む**: `POST /admin/ebay/platform-notification-setup`が登録時に`signWebhookDestinationToken`(HMAC、このアプリのeBay client secret、有効期限なし)でテナントごとのトークンを発行し、`/webhooks/ebay/platform-notifications/{token}`という形でeBayに登録する。これにより(1)完全に推測可能だった静的パスがなくなり、(2)eBayの通知ペイロード自体にはテナント情報が一切ないという問題も同時に解決する(トークンからtenantIdを復元)。
- **debounce/coalescing**: `triggerCoalescedPoll`が`idempotency_keys`テーブルを純粋なrate-limitミューテックスとして再利用(`complete()`を呼ばず`tryClaim`のTTLだけを使う)し、同一tenant/channelへの通知は20秒間に1回しか実際のpollを起動しない。実際のpollは`ebayPlatformNotificationPoll` SQSキュー経由で別Lambda(`dispatchPoll`)が行うため、webhook自体のリクエストパス上では同期的なeBay API呼び出しが一切発生しない。
- **API Gateway throttling**: このルートだけ`5 req/s, burst 10`に制限(他ルートの既定は`50 req/s, burst 100`)。**`PlatformConfig.ebayPlatformNotificationThrottleEnabled`(既定`false`)で明示的に有効化する必要がある** — 本番デプロイで2回連続して失敗した実際の障害(`AWS::ApiGatewayV2::Stage` UPDATE_FAILED: `Unable to find Route by key POST /webhooks/ebay/platform-notifications/{token} within the provided RouteSettings`)の根本原因は、このルート別throttle設定がHttpApiのStageリソース(`ApiCoreStack`所有)に対する更新である一方、そのルート自体(`AWS::ApiGatewayV2::Route`)は別スタック(`ApiStack`)が作るため — `ApiCoreStack`は`ApiStack`より必ず先にデプロイされる(`LambdaStack`がAPIエンドポイントを必要とするため)ので、**このルートを初めてデプロイする回**は、Stage更新がRoute作成より先に走ってしまい、存在しないルートキーを参照して必ず失敗する。CloudFormationのスタック依存は双方向にできない(`ApiStack`は既に`ApiCoreStack`に依存している)ため、順序を逆にする回避策もない。
  - **手順**: (1) 該当環境でこのルートを初めてデプロイする回は、`enableEbayPlatformNotificationThrottle`をfalse(既定)のままデプロイ — throttleなしでRouteだけ作成される。(2) それが成功した後の**次回以降のデプロイ**で、`workflow_dispatch`の`enableEbayPlatformNotificationThrottle`入力をtrueにして再デプロイ — 今度はRouteが既に存在するのでStage更新が成功する。一度trueにして成功すれば、以降は毎回trueのままで問題ない。
- **WAF**: round 15でCloudFrontを実際の本番経路として使えるようにした(下の「WAF/CloudFrontの本番適用」参照)。デフォルトはまだ直接execute-apiのままで、切り替えは明示的な運用手順が必要。
- **既存のeBay Platform Notification購読への影響**: ルートが`{token}`必須になったため、**このデプロイ前に登録された(トークンなしの)購読はeBayからの配信が404になる**。該当テナントで`POST /admin/ebay/platform-notification-setup`を再実行し、新しいトークン付きURLで再登録すること。
- REST Notification API側(`/webhooks/ebay/notifications`、X-EBAY-SIGNATURE検証あり)は今回スコープ外 — 既にBOOTSTRAP_TENANT_ID固定だが、署名検証があるため悪用リスクは低い。debounceのみ同じ仕組みを適用した。

### WAF/CloudFrontの本番適用と、direct execute-api URLの制限

**現状(round 15完了時点)**: `infra/lib/cloudfront-stack.ts`のWAF付きCloudFrontディストリビューションは技術的に完成している(`CACHING_DISABLED` + `OriginRequestPolicy.ALL_VIEWER`で認証ヘッダ・生bodyともに素通し確認済み)が、**デフォルトでは何もこれを使っていない**。`PlatformConfig.apiEntrypoint`(`infra/lib/config.ts`)が`"direct"`(既定)か`"cloudfront"`かを1箇所で決める:

- `"direct"`(既定・現状維持): `BASE_OAUTH_REDIRECT_URI`・eBay webhook宛先・管理画面のAPI URLは全部これまで通り直接execute-apiのURL。WAFは立っているが本番トラフィックは一切通らない。
- `"cloudfront"`: 上記すべてがCloudFrontのURLに切り替わる。**同時に**、CloudFrontが注入するシークレットヘッダ(`X-CloudFront-Secret`、Secrets Manager `cloudfront-shared-secret`から自動生成)をLambda側の`requireCloudFrontOrigin`(`services/lambdas/shared/src/cloudfront-origin.ts`)が検証するようになり、このヘッダを持たない直接execute-apiへのリクエストは403で拒否される。**HTTP API v2はresource policyもWAFの直接アタッチも非対応**(REST APIとの既知の違い、AWS公式ドキュメントで確認済み)なので、この「共有シークレットヘッダ」がAWS自身も推奨する代替策。

**なぜ自動で切り替えないか**: `BASE_OAUTH_REDIRECT_URI`はBASEの開発者コンソール側にも登録されており、Stripeのwebhook宛先もStripeダッシュボード側の設定。このコードベースだけでは変更できない。ここを揃えずに`apiEntrypoint`だけ切り替えると、新規BASE接続とStripe webhook配信がその場で壊れる。

**切り替え手順(この順序を守ること)**:

1. BASEの開発者コンソールで、このアプリのOAuthアプリ設定のredirect_uriを`https://<CloudFrontドメイン>/oauth/base/callback`に**追加**(既存の直接URLを消すのはまだ早い — 後述)。
2. Stripeダッシュボード → Webhooks で、エンドポイントURLを`https://<CloudFrontドメイン>/webhooks/stripe`に更新(またはCloudFront宛の新エンドポイントを追加)。
3. `apps/admin/.env.local`(gitignore対象、Amplifyのビルド設定ではなくローカルのビルド時にJSへ焼き込まれる)の`NEXT_PUBLIC_API_BASE_URL`をCloudFrontのURLに変更し、管理画面を再ビルド・再デプロイ。
4. `cdk deploy --all --context apiEntrypoint=cloudfront ...`(または`deploy.yml`のworkflow_dispatch入力にcontextを追加)を実行。これでLambda側のURL群とCLOUDFRONT_SHARED_SECRETが切り替わる。
5. 管理画面から実際にBASE/eBay接続・Stripe課金・商品同期が新URL経由で動くことを確認。
6. 問題なければ、eBayの各webhook購読(`POST /admin/ebay/webhook-setup`・`POST /admin/ebay/platform-notification-setup`)をテナントごとに再実行してCloudFront URLへ再登録。
7. 数日〜1週間、旧URL(直接execute-api)への到達がないことをCloudWatch Logsで確認できたら、BASEコンソールから旧redirect_uriを削除。

**ロールバック**: `apiEntrypoint`を`"direct"`に戻して再デプロイすれば、Lambda側は即座に旧URL/旧設定に戻る(BASE/Stripe側は手順1・2で「追加」しているだけなので、消していなければそのまま両対応の状態を維持できる)。

## デプロイフローとDB migration

### 新しいデプロイフロー(round 15で変更)

`workflow_dispatch` → `cdk deploy --all` → **DbMigrate Lambda呼び出し(新規)** → **post-deploy smoke test(新規)**。migrationとsmoke testはどちらも失敗時に`exit 1`でジョブ全体を失敗扱いにする(「prodではmigration failure時に明確にdeploy失敗にする」の実装)。

- migrationステップは`aws cloudformation describe-stacks`でLambdaStackの`DbMigrateFunctionName`出力を引き、`aws lambda invoke`で直接呼び出す。レスポンスの`FunctionError`フィールドで成否判定(Lambda呼び出し自体のexit codeは関数内部のエラーでは非0にならないため)。
- drizzleの migrator は適用済みmigrationを自分のテーブルで管理するため、**何度実行しても安全**(新しいmigrationがなければ単に何もしない)。
- smoke testは`GET /webhooks/ebay/notifications`(challenge_codeなし)を叩き、HTTP 400が返ることだけを確認する認証不要・副作用なしの疎通確認。DBを実際に触る確認はmigrationステップ自体がすでに兼ねている。

### リソース削除時のスタック間export/import順序問題(`targetStacks`入力)

Lambda関数やその他のリソースを削除するコード変更(例: round 12でのOAuth authorizeルート廃止)を、その関数のARNを別スタックが`Fn::ImportValue`で参照したままの状態から初めて本番にデプロイすると、CloudFormationは`Cannot delete export ... as it is in use by ...`で失敗する。`cdk deploy --all`は常に依存関係順(例: `Lambdas`→`Api`)でスタックを処理するため、「先にimport側(`Api`)だけを更新してexport(`Lambdas`)を未使用にしてから、export側を更新する」という2段階デプロイが`--all`では実現できない。

対処として、`deploy.yml`の`workflow_dispatch`に`targetStacks`(既定は空 = 通常通り`--all`)を追加した。この現象に遭遇したら:

1. `targetStacks`に、importしている側のスタック名(例: `AiEcPlatform-prod-Api`)を指定してデプロイ実行 → `cdk deploy <指定スタック> --exclusively`が走り、依存スタック(`Lambdas`など)は一切触らずそのスタックだけを更新する。importが外れる。
2. それが成功したら、`targetStacks`を空に戻して通常通り`--all`で再デプロイ → 今度はexport側のスタックが安全に該当リソースを削除できる。

普段は`targetStacks`は空のままにしておくこと。

**この変更を有効にする前に必須の作業**: `deployRole`(GitHub Actionsが引き受けるIAMロール)に`lambda:InvokeFunction`/`cloudformation:DescribeStacks`権限を追加した(`infra/lib/github-oidc-stack.ts`)。この`GithubOidcStack`は**人手による一度きりのブートストラップ**(README上部の手順参照)であり、`deploy.yml`が自動デプロイする対象では**ない**。そのため、この変更をコード上マージしただけでは本番のIAMロールには反映されない — 以下を一度だけ手動実行すること:

```bash
cd infra && npx cdk deploy AiEcPlatform-<env>-GithubOidc \
  --context bootstrapOidc=true \
  --context githubRepo=<owner>/<repo>
```

これを実行しないまま次回`deploy.yml`を回すと、新しい"Run DB migration"/"Post-deploy smoke test"ステップがAccessDeniedで失敗する。

### migration failureの挙動とロールバック方針

- migration自体が失敗(SQL構文エラー、既存データとの制約違反等)した場合、deployジョブは赤字で失敗し、**CDKによるLambdaコード自体のデプロイはすでに完了している**状態になり得る(新Lambda + 未適用schemaの共存)。この場合の復旧は、(a) 問題のmigration SQLを修正した新しいmigrationファイルを追加して再デプロイするか、(b) 直前の(migrationを含まない)コミットへLambdaコードだけを再デプロイして手動でDBを復旧するか、状況に応じて判断する。
- 本番運用としては、破壊的な変更(列削除・型変更・NOT NULL化)は**expand/contract方式**(まず新しい列/形を追加 → コードを新形式に対応させてデプロイ → 十分な期間後に旧列を削除する別のmigrationを出す)を採用し、「新Lambda + 旧schema」の組み合わせでも新Lambdaが動き続けられる状態を常に保つ。このセッションのこれまでのmigration(0013〜0015)はすべてこの原則に従っており(nullable列の追加のみ、既存列の削除・変更なし)、今後もこの方針を維持すること。

### 確認コマンド

```bash
# DbMigrate Lambdaの実際の関数名を確認
aws cloudformation describe-stacks --stack-name AiEcPlatform-<env>-Lambdas \
  --query "Stacks[0].Outputs[?OutputKey=='DbMigrateFunctionName'].OutputValue" --output text

# 手動でmigrationを再実行(deploy.ymlと同じ呼び出し)
aws lambda invoke --function-name <上記の関数名> --payload '{}' response.json && cat response.json

# CloudFrontのURLを確認
aws cloudformation describe-stacks --stack-name AiEcPlatform-<env>-CloudFrontApi \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" --output text
```

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
  oauth-base/       BASE OAuth callback(公開)。authorize-urlの発行はadmin-apiの認証済みroute
  oauth-ebay/       eBay OAuth callback(公開)。authorize-urlの発行はadmin-apiの認証済みroute
  product-fetch/    BASE商品ポーリング→商品マスター反映(EventBridge)
  ai-generate-worker/  AI生成ワーカー(SQS)
  ebay-sync-worker/    eBay出品/更新ワーカー(SQS)
  sales-poller/     BASE/eBay売却検知(EventBridge)
  inventory-sync-worker/ 在庫同期・二重販売対策(SQS)
  inventory-diff-check/  在庫差分チェック(EventBridge、日次)
  tenant-offboarding/    解約テナントのmarketplace delist + OAuth revoke(EventBridge、1時間毎)
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
7. AWSコンソールで `DbMigrate` Lambda(`services/lambdas/db-migrate`)を1回テスト実行し、`packages/db/migrations/*.sql` を適用してブートストラップテナント行を作成する(繰り返し実行しても安全 -- drizzleの標準マイグレーターが適用済みを記録する)。新しいマイグレーションを追加した際も、同じLambdaを再実行すればよい。
8. Cognitoに管理者ユーザーを作成(`aws cognito-idp admin-create-user`。カスタム属性 `custom:tenant_id` に、ステップ7で作成したブートストラップテナントのID(`00000000-0000-0000-0000-000000000001`)を設定する)。
9. BASE/eBayのOAuth接続は、ステップ8で作成した管理者アカウントで管理画面にログインし、`/onboarding`(または`/commerce`・サイドバー)の「連携」ボタンから行う。**(round 12の変更点)** 以前存在した公開・無認証の `GET /oauth/{base,ebay}/authorize` ルートは廃止した — マルチテナントSaaSでは危険(認証なしに任意のtenantIdへOAuth接続を紐付けられた)なため。ステップ8で作成したCognitoユーザーは`custom:tenant_id`にブートストラップテナントIDを持つので、認証済みの`GET /admin/oauth/{channel}/authorize-url`が自動的に同じテナント向けの署名済みstateを発行する — 追加の移行作業は不要。


### 2. 通常のデプロイフロー

mainへの直接pushは禁止(ブランチ保護をリポジトリ側で設定)。PRマージ後、`workflow_dispatch`で`prod`環境を指定して手動トリガー → GitHub Environmentの承認待ち → 承認後にOIDCでAWSへデプロイ。

## セキュリティ

- APIキー・OAuthトークンはGitHub/DBに平文保存しない(Secrets Manager + ARN参照のみ)。
- GitHub→AWSはOIDC(静的キーなし)。
- 各Lambdaは最小権限のIAMロール(DB Data API・該当Secrets・該当SQSキューのみ)。
- 本番デプロイ・Secrets変更・商品公開(eBay出品)は人間承認が必須な設計。

### TOTP(MFA)紛失時の復旧手順

Cognitoユーザープールは `Mfa.REQUIRED` — 全アカウントがTOTP必須で、セルフサービスの復旧フローは現状存在しない。認証アプリの機種変更・紛失を店舗から連絡された場合、運営者は以下の手順で本人確認の上MFAを再設定する。

1. **本人確認**: 登録メールアドレス宛に確認メールを送り、返信または別の合意済み手段(電話等)で本人であることを確認する。契約情報(会社名・登録メール)が一致することを確認してから次に進む。
2. **MFA設定の解除**: 該当ユーザーのMFA設定を解除する。
   ```bash
   aws cognito-idp admin-set-user-mfa-preference \
     --user-pool-id <USER_POOL_ID> \
     --username <ユーザーのメールアドレス> \
     --software-token-mfa-settings Enabled=false
   ```
3. **店舗へ案内**: 次回ログイン時にTOTPの再設定画面(QRコード)が表示される旨を伝える。パスワード自体は変更不要(紛失は認証アプリのみが対象の場合)。
4. **監査ログへの記録**: 対応した日時・担当者・確認方法を運営側の記録(スプレッドシート等)に残す — このサービス自体の `audit_log` はテナント操作を記録する仕組みであり、運営者によるCognito操作はその対象外のため、別途手元で記録すること。

パスワード自体も忘れている場合は、`admin-set-user-password --permanent` で新しいパスワードを設定し、上記と合わせて案内する。セルフサービス化(店舗側で完結する復旧フロー)は将来の改善候補。
