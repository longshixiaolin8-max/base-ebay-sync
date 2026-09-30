# デプロイランブック(実AWSアカウントへの初回デプロイ〜本番運用開始)

「本番ようにしてすべて」レビューのスコープ3(実際にAWSへデプロイする準備)向けの成果物。README各所に散らばっている手順(ブートストラップ、P0タスク、SES設定、WAF/CloudFront切替、TOTP復旧など)を、**実行順に並べた1本のチェックリスト**としてここにまとめる。各項目の詳細な理由・背景はREADME該当セクションにリンクしてあるので、「なぜそうなっているか」はそちらを参照。このランブック自体はこのセッションでは実行できていない(有効なAWS認証情報がないため) — 実際にデプロイする人が上から順にチェックしていくための手順書。

## Phase 0: 前提条件

- [ ] AWSアカウント(このプラットフォーム専用、または既存アカウント内の専用リージョン)
- [ ] GitHubリポジトリの管理者権限(Environments設定・Secrets/Variables設定のため)
- [ ] BASE開発者アカウント・アプリ登録(OAuth client id/secret)
- [ ] eBay開発者アカウント・アプリ登録(Sandbox→本番の昇格含む、OAuth client id/secret)
- [ ] Stripeアカウント(test mode → live modeへの切替も別途必要)
- [ ] SES送信元として使えるドメイン、またはメールアドレス

## Phase 1: 一度きりの人手によるブートストラップ

詳細は README「デプロイ > 1. 一度きりの人手によるブートストラップ」参照。

1. [ ] 自分のAWS認証情報で `GithubOidc` スタックをデプロイし、GitHub ActionsがOIDCでAssumeできるIAMロールを作成:
   ```bash
   cd infra && npx cdk deploy AiEcPlatform-dev-GithubOidc \
     --context bootstrapOidc=true --context githubRepo=<owner>/<repo> --context region=us-east-2
   ```
   prod環境用にも同様に実行する(`AiEcPlatform-prod-GithubOidc`)。
2. [ ] リポジトリの Settings → Environments に `dev` と `prod` を作成。`prod` には必須レビュアーを設定する(本番デプロイの人間承認ゲート)。
3. [ ] リポジトリ変数に `AWS_DEPLOY_ROLE_ARN` / `AWS_REGION`(`us-east-2`) / `ALARM_EMAIL` を設定(AWSキー自体は保存しない — OIDCのみ)。
4. [ ] 対象アカウント/リージョンに対して `cdk bootstrap` を実行。

## Phase 2: 環境ごとの初回デプロイ(まず`dev`、動作確認後に`prod`)

1. [ ] `.github/workflows/deploy.yml` を `workflow_dispatch` から実行(`environment=dev`)。**初回デプロイでは以下のcontextはいずれも既定値(未指定)のままにすること**:
   - `apiEntrypoint`(既定`direct`) — CloudFront切替はPhase 5で別途行う。
   - `ebayPlatformNotificationThrottleEnabled`(既定`false`) — このルート自体が初めて作られるデプロイでは`true`にすると失敗する(詳細: README「eBay Platform Notification abuse対策」)。
   - `sesFromEmail`(既定未設定) — SES検証がまだなので後回し(Phase 2の後半で設定)。
2. [ ] デプロイ成功後、Secrets Managerの `ai-ec-platform/app-credentials/{base,ebay,openai,stripe}` と `.../signup` に実クレデンシャルを投入する。
3. [ ] AWSコンソールで `DbMigrate` Lambda(`services/lambdas/db-migrate`)を1回テスト実行し、`packages/db/migrations/*.sql`を適用してブートストラップテナント行を作成する(繰り返し実行しても安全)。
   ```bash
   aws cloudformation describe-stacks --stack-name AiEcPlatform-dev-Lambdas \
     --query "Stacks[0].Outputs[?OutputKey=='DbMigrateFunctionName'].OutputValue" --output text
   aws lambda invoke --function-name <上記の関数名> --payload '{}' response.json && cat response.json
   ```
4. [ ] Cognitoに管理者ユーザーを作成する。カスタム属性 `custom:tenant_id` に、ステップ3で作成したブートストラップテナントのID(`00000000-0000-0000-0000-000000000001`)を設定する。
   ```bash
   aws cognito-idp admin-create-user --user-pool-id <USER_POOL_ID> --username <管理者メールアドレス> \
     --user-attributes Name=custom:tenant_id,Value=00000000-0000-0000-0000-000000000001
   ```
5. [ ] Amplify Hostingとこのリポジトリを接続する(AWSコンソールから — GitHub Appトークンはコードに置かない)。接続後、`apps/admin`のビルド設定で環境変数`NEXT_PUBLIC_API_BASE_URL`(ApiCoreStackの`ApiUrl`出力)と`NEXT_PUBLIC_COGNITO_*`(AuthStackの出力)を設定する。
6. [ ] SESで送信元アドレス、またはドメインを検証する(AWSコンソール)。ドメイン検証はDNSレコード追加が必要。SESがサンドボックスモードのままだと検証済みの宛先にしか送れないので、本番送信するにはサンドボックス解除も別途リクエストする(詳細: README「請求関連メール通知(SES)」)。
7. [ ] SES検証が済んだら、`--context sesFromEmail=notifications@yourdomain.example` を付けて`Lambdas`スタックを再デプロイし、`billingNotice`メールを有効化する。
8. [ ] ステップ4で作成した管理者アカウントで管理画面にログインし(初回ログイン時にTOTP設定画面が出る)、`/onboarding`または`/commerce`からBASE/eBayのOAuth接続を行う。
9. [ ] 管理画面の「連携」設定から、eBayのREST Notification API購読(`POST /admin/ebay/webhook-setup`)とPlatform Notification購読(`POST /admin/ebay/platform-notification-setup`)を行う(それぞれ管理画面のボタン経由)。
10. [ ] Stripeダッシュボードで、Webhookエンドポイントを`<ApiUrl>/webhooks/stripe`に登録し、署名シークレットをSecrets Managerの`stripe`クレデンシャルに反映する。

## Phase 3: スモークテスト(dev環境で本番投入前に必ず確認)

- [ ] ログイン・TOTPセットアップが完了する。
- [ ] BASE/eBay接続カードが「連携済み」になる(`/commerce`または設定タブ)。
- [ ] BASE側に登録した商品が`product-fetch`(15分毎)で商品マスターに反映される、または管理画面から手動トリガーできる。
- [ ] AI下書きが生成され(`/drafts`)、承認操作で実際にeBayへ出品される(`ebay-sync-worker`経由)。
- [ ] どちらかのチャネルで売却させ、`sales-poller`(1分毎)→`inventory-sync-worker`で在庫が0になり、もう片方のチャネルにも反映される。
- [ ] 設定タブ(通知設定・テナント設定・価格デフォルト)の保存(PATCH)がブラウザから実際に成功する — 本ラウンドで見つけたCORSのPATCH漏れ修正の直接的な確認ポイント。ブラウザのDevToolsでCORSエラーが出ていないこと。
- [ ] StripeのWebhook用テストイベント(`invoice.payment_failed`等をStripe CLIやダッシュボードから送信)で、テナントのステータスが変わり、SES設定済みなら実際にメールが届く。
- [ ] CloudWatchダッシュボード(`ai-ec-platform-dev`)にDLQ深度・Lambdaエラー率・新設の`*ThrottleAlarm`グラフが表示され、アラームがすべて`OK`状態であること。

## Phase 4: platform-notificationsルートのスロットル有効化(2回目のデプロイ)

Phase 2で作成した`/webhooks/ebay/platform-notifications/{token}`ルートが実際にAWS上に存在することを確認した後、`--context ebayPlatformNotificationThrottleEnabled=true`を付けて再デプロイする(詳細: README「eBay Platform Notification abuse対策」)。

## Phase 5(任意・prodのみ、時間を空けて段階的に): WAF付きCloudFrontへの切替

CloudFrontは既に立っているが、既定では未使用(`apiEntrypoint: "direct"`)。実際に切り替える場合は、BASE開発者コンソール・Stripeダッシュボード側の設定変更を伴う多段階の手順が必要 — README「WAF/CloudFrontの本番適用と、direct execute-api URLの制限」の7ステップの手順とロールバック手順を**必ず**その順序で実行すること。ここでは省略しない理由(BASE/Stripe側の外部コンソール変更が絡むため、順序を守らないと本番のBASE接続・Stripe課金が即座に壊れる)も含め、README側が正本。

## Phase 6: 本番(prod)への昇格

1. [ ] Phase 1〜4をdev環境で一通り確認できたら、同じ手順をprod環境に対して繰り返す(`workflow_dispatch`の`environment=prod`、GitHub Environmentの必須レビュアー承認を経由)。
2. [ ] Stripeをtest modeからlive modeに切り替え、Secrets Managerのprod用`stripe`クレデンシャルをlive modeのキー・Webhook署名シークレットに更新する。
3. [ ] eBay/BASEのアプリをSandbox/開発モードから本番モードに昇格し、prod用Secrets Managerのクレデンシャルを本番キーに更新する。
4. [ ] AWS Budgetsの`monthlyBudgetUsd`(既定50)を実際の想定コストに合わせて`--context monthlyBudgetUsd=...`で調整する。

## 日常運用・障害対応の参照先

- **DLQに溜まったメッセージの再試行**: `dlq-redrive` Lambda(30分毎の自動実行)が自動で行うが、手動で即時実行したい場合はAWSコンソールから直接invoke可能。
- **TOTP紛失時の復旧**: README「TOTP(MFA)紛失時の復旧手順」参照。
- **migration失敗時の復旧方針**: README「migration failureの挙動とロールバック方針」参照。
- **スタック削除時のexport/import順序問題**: README「リソース削除時のスタック間export/import順序問題」参照(`targetStacks`入力の使い方)。
- **監視**: CloudWatchダッシュボード `ai-ec-platform-<env>`(DLQ深度・Lambdaエラー率・チャネル別sync error/isolation・新設のLambdaスロットル)。アラームは全て`MonitoringStack`のSNSトピック(`ALARM_EMAIL`宛)に通知される。
