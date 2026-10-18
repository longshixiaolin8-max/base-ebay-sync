/**
 * Maps Amplify/Cognito auth exception names (err.name) to Japanese guidance. Without this,
 * login/forgot-password/MFA error handling fell through to showing Cognito's raw English SDK
 * message verbatim (e.g. "Incorrect username or password.", "Password did not conform with
 * policy: ...") -- unlike signup's own confirmSignup flow, which already maps every API error
 * code it can hit to Japanese copy. Covers every exception this app's own auth flows can
 * realistically trigger; anything unmapped falls back to the caller's own generic message,
 * never the raw SDK text.
 */
const COGNITO_ERROR_MESSAGE: Record<string, string> = {
  NotAuthorizedException: "メールアドレスまたはパスワードが正しくありません。",
  UserNotFoundException: "該当するアカウントが見つかりません。",
  InvalidPasswordException: "パスワードの条件を満たしていません。12文字以上で、大文字・小文字・数字・記号を組み合わせてください。",
  CodeMismatchException: "確認コードが正しくありません。",
  ExpiredCodeException: "確認コードの有効期限が切れています。再送信してください。",
  LimitExceededException: "試行回数の上限に達しました。しばらくしてからもう一度お試しください。",
  TooManyRequestsException: "リクエストが多すぎます。しばらくしてからもう一度お試しください。",
  TooManyFailedAttemptsException: "失敗回数が多すぎます。しばらくしてからもう一度お試しください。",
  PasswordResetRequiredException: "パスワードの再設定が必要です。「パスワードを忘れた方」からお進みください。",
  InvalidParameterException: "入力内容を確認してください。",
  NetworkError: "通信に失敗しました。接続状況を確認してもう一度お試しください。",
};

/** `fallback` must itself already be Japanese and generic -- it's what's shown for any
 *  exception name this map doesn't recognize, so it is never the raw error message either. */
export function cognitoErrorMessage(err: unknown, fallback: string): string {
  const name = err instanceof Error ? err.name : undefined;
  if (name && COGNITO_ERROR_MESSAGE[name]) return COGNITO_ERROR_MESSAGE[name];
  return fallback;
}
