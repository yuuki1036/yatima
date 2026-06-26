"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CurationCard, FeedbackAction } from "@/lib/types";
import { SwipeCard } from "./swipe-card";

// スワイプで送ると判定する閾値（px）。これを超えて指を離すと dismiss/useful を発火。
const SWIPE_THRESHOLD = 90;

type Props = {
  cards: CurationCard[];
  // 今日の総ピック数（判定済み込み）。リロード後に判定済みを除外した cards が空でも、
  // 「ピック未生成」と「全件判定済み（完了）」を区別して表示し分けるために使う。
  pickedToday: number;
  // Server Action を prop で受け取る（Next.js のクライアント連携パターン）。
  submitFeedbackAction: (formData: FormData) => void;
};

// 今日のカードを1枚ずつ捌く Tinder UI。送り操作はクライアント state で楽観的に前進し、
// DB 反映（嗜好更新）は Server Action でバックグラウンド送信する（往復待ちで詰まらせない）。
export function CurationDeck({
  cards,
  pickedToday,
  submitFeedbackAction,
}: Props) {
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

  // ── フリック（スワイプ）対応: カードを左右にドラッグして送る ─────────────
  // ポインタ操作（タッチ + マウス兼用）。8px 動いて初めてドラッグ扱いにし、タイトルの
  // タップ（リンク）を温存する。閾値超えで dismiss/useful を発火。
  const [dx, setDx] = useState(0); // 現在のドラッグ量（px）
  const [dragging, setDragging] = useState(false);
  const [flyOut, setFlyOut] = useState<null | "left" | "right">(null);
  const dragStartX = useRef(0);
  const pointerActive = useRef(false);
  const draggingRef = useRef(false); // 判定は ref で行う（state クロージャの陳腐化を避ける）
  const dxRef = useRef(0);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (flyOut) return; // 飛ばし中は新規ドラッグを受けない
      dragStartX.current = e.clientX;
      pointerActive.current = true;
    },
    [flyOut],
  );
  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerActive.current) return;
    const d = e.clientX - dragStartX.current;
    if (!draggingRef.current) {
      if (Math.abs(d) < 8) return; // 微動はドラッグ扱いせずタップを温存
      draggingRef.current = true;
      setDragging(true); // 見た目（transition/カーソル）用
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    dxRef.current = d;
    setDx(d);
  }, []);
  const endDrag = useCallback(() => {
    pointerActive.current = false;
    if (!draggingRef.current) return; // タップ（ドラッグ未開始）は何もしない
    draggingRef.current = false;
    setDragging(false);
    const d = dxRef.current;
    if (d > SWIPE_THRESHOLD) setFlyOut("right");
    else if (d < -SWIPE_THRESHOLD) setFlyOut("left");
    else {
      dxRef.current = 0;
      setDx(0); // 閾値未満はスナップバック
    }
  }, []);

  // 飛ばし切ったらフィードバックを送って次の1枚へ（飛ぶアニメ後に発火）。
  useEffect(() => {
    if (!flyOut || !current) return;
    const t = setTimeout(() => {
      send(current, flyOut === "right" ? "useful" : "dismiss");
      dxRef.current = 0;
      setDx(0);
      setFlyOut(null);
    }, 180);
    return () => clearTimeout(t);
  }, [flyOut, current, send]);

  // セクションラベル（赤・mono）。完了/未生成の各状態でも共通して頭に出す。
  const sectionLabel = (counter?: string) => (
    <div className="mb-5 flex items-baseline justify-between">
      <span className="font-mono text-xs font-medium tracking-widest text-accent">
        TODAY&apos;S PICK
      </span>
      {counter && (
        <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
          {counter}
        </span>
      )}
    </div>
  );

  if (deck.length === 0) {
    // ピックは生成されたが全件判定済み（リロード後）→ 完了表示。
    // 未生成（pickedToday=0）と区別する。
    if (pickedToday > 0) {
      return (
        <div>
          {sectionLabel()}
          <p className="border border-line py-16 text-center text-sm text-muted">
            今日は完了です 🎉
            <br />
            今日の{pickedToday}件はすべて判定済みです。
          </p>
        </div>
      );
    }
    return (
      <div>
        {sectionLabel()}
        <p className="border border-line py-16 text-center text-sm text-muted">
          今日のピックはまだありません。
          <br />
          記事の取得とキュレーションは定期実行されます。少し待って再読み込みしてください。
        </p>
      </div>
    );
  }

  if (!current) {
    return (
      <div>
        {sectionLabel(`${deck.length} / ${deck.length}`)}
        <p className="border border-line py-16 text-center text-sm text-muted">
          今日は完了です 🎉
          <br />
          全{deck.length}件を見終わりました。
        </p>
      </div>
    );
  }

  return (
    <div>
      {sectionLabel(
        `${String(index + 1).padStart(2, "0")} / ${String(deck.length).padStart(2, "0")}`,
      )}

      <div
        className="relative touch-pan-y select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          className={dragging ? "cursor-grabbing" : "cursor-grab"}
          style={{
            transform: flyOut
              ? `translateX(${flyOut === "right" ? 1000 : -1000}px) rotate(${
                  flyOut === "right" ? 18 : -18
                }deg)`
              : `translateX(${dx}px) rotate(${dx * 0.04}deg)`,
            transition: dragging ? "none" : "transform 180ms ease-out",
            opacity: flyOut ? 0 : 1,
          }}
        >
          <SwipeCard card={current} index={index + 1} />
        </div>

        {/* スワイプ方向のヒント（指の移動量に応じてフェードイン） */}
        <div className="pointer-events-none absolute inset-0 flex items-start justify-between p-4">
          <span
            className="border-2 border-border px-3 py-1 font-mono text-base font-bold tracking-widest text-foreground"
            style={{
              opacity: dx < 0 ? Math.min(1, -dx / SWIPE_THRESHOLD) : 0,
              transform: "rotate(-12deg)",
            }}
          >
            SKIP
          </span>
          <span
            className="border-2 border-accent px-3 py-1 font-mono text-base font-bold tracking-widest text-accent"
            style={{
              opacity: dx > 0 ? Math.min(1, dx / SWIPE_THRESHOLD) : 0,
              transform: "rotate(12deg)",
            }}
          >
            KEEP
          </span>
        </div>
      </div>

      <div className="mt-5 flex border border-border divide-x divide-border font-mono text-sm tracking-widest">
        <button
          onClick={() => send(current, "dismiss")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          ← SKIP
        </button>
        <button
          onClick={() => send(current, "open")}
          className="flex-1 bg-accent px-4 py-3 font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          OPEN
        </button>
        <button
          onClick={() => send(current, "useful")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          KEEP →
        </button>
      </div>

      <p className="mt-3 text-center font-mono text-xs tracking-widest text-faint">
        ← SKIP　·　ENTER OPEN　·　KEEP →
      </p>
    </div>
  );
}
