import { AskForm } from "./ask-form";

// 横断 Q&A（Phase5 / YAT-22）。蓄積記事に自然言語で質問し、関連記事を根拠に出典付きで回答する。
// 認証は proxy.ts が一括でゲートする（読み取り専用ページなので requireSession は不要。
// 重い処理を起こす Server Action 側で requireSession を二段目に噛ませている）。
export const dynamic = "force-dynamic";
// Server Action（embed + retrieval + LLM）が同期実行で数十秒かかりうるため関数時間を延ばす。
export const maxDuration = 60;

export default function AskPage() {
  return (
    <div>
      <div className="mb-5">
        <span className="font-mono text-xs font-medium tracking-widest text-accent">
          ASK
        </span>
      </div>

      <p className="mb-5 text-sm text-muted">
        直近 1 ヶ月の記事を横断して質問できます。回答は記事を根拠に生成され、出典を表示します。
      </p>

      <AskForm />
    </div>
  );
}
