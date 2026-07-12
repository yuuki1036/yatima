// 全ルート共通の遷移スケルトン。App Router では root の loading.tsx が `/` と独自 loading を
// 持たない全子ルートをラップするため、この 1 枚で全ページの遷移中フォールバックを賄う（YAT-40）。
// 全ページ force-dynamic のためナビ遷移でサーバのデータ取得完了まで待つ間、ここが即表示される。
// 中身はページ非依存の汎用プレースホルダ（ラベル＋コンテンツ枠）に留める。パルス抑制は CSS のみ。
export default function Loading() {
  return (
    <div
      role="status"
      aria-label="読み込み中"
      className="animate-pulse motion-reduce:animate-none"
    >
      {/* セクションラベル相当の帯 */}
      <div className="mb-5 h-3 w-32 bg-line" />
      {/* コンテンツ枠（カード／一覧いずれにも読める中立な箱） */}
      <div className="space-y-4">
        <div className="h-44 border border-line bg-surface" />
        <div className="h-11 border border-line bg-surface" />
      </div>
    </div>
  );
}
