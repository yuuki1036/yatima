"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { CurationCard, FeedbackAction } from "@/lib/types";
import { SwipeCard } from "./swipe-card";

type Props = {
  cards: CurationCard[];
  // Server Action を prop で受け取る（Next.js のクライアント連携パターン）。
  submitFeedbackAction: (formData: FormData) => void;
};

// 今日のカードを1枚ずつ捌く Tinder UI。送り操作はクライアント state で楽観的に前進し、
// DB 反映（嗜好更新）は Server Action でバックグラウンド送信する（往復待ちで詰まらせない）。
export function CurationDeck({ cards, submitFeedbackAction }: Props) {
  const [index, setIndex] = useState(0);
  const [, startTransition] = useTransition();

  // cards はマウント時に固定する。フィードバックの Server Action は（revalidate 有無に関わらず）
  // カレントルートを再レンダーし「判定済みを除外した cards」を渡してくる。これを使うと楽観的に
  // 進める index と二重にズレてカードが飛ぶため、セッション中は初期リストを真実とする。
  // 続き（判定済みの除外）はリロード/再訪時にサーバクエリが行う。
  const [deck] = useState(cards);

  const current: CurationCard | undefined = deck[index];

  const send = useCallback(
    (card: CurationCard, action: FeedbackAction) => {
      // 「開く」は別タブでリンクを開く（clicked シグナル）。
      if (action === "open" && card.url) {
        window.open(card.url, "_blank", "noopener,noreferrer");
      }
      const fd = new FormData();
      fd.set("id", card.id);
      fd.set("action", action);
      startTransition(() => submitFeedbackAction(fd));
      setIndex((i) => i + 1); // 楽観的に次の1枚へ
    },
    [submitFeedbackAction],
  );

  // キーボード操作: ← 興味なし / → 興味あり / Enter 開く
  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        send(current!, "dismiss");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        send(current!, "useful");
      } else if (e.key === "Enter") {
        e.preventDefault();
        send(current!, "open");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, send]);

  if (deck.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-zinc-500">
        今日のピックはまだありません。
        <br />
        「今すぐ取得」で記事を集めてください。
      </p>
    );
  }

  if (!current) {
    return (
      <p className="py-16 text-center text-sm text-zinc-500">
        今日は完了です 🎉
        <br />
        全{deck.length}件を見終わりました。
      </p>
    );
  }

  return (
    <div>
      <div className="mb-3 text-right text-xs text-zinc-400">
        {index + 1} / {deck.length}
      </div>

      <SwipeCard card={current} />

      <div className="mt-5 flex items-center justify-center gap-3">
        <button
          onClick={() => send(current, "dismiss")}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          ← 興味なし
        </button>
        <button
          onClick={() => send(current, "open")}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          開く
        </button>
        <button
          onClick={() => send(current, "useful")}
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          興味あり →
        </button>
      </div>

      <p className="mt-3 text-center text-xs text-zinc-400">
        ← 興味なし　·　Enter 開く　·　→ 興味あり
      </p>
    </div>
  );
}
