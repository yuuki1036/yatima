"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import type { CurationCard, FeedbackAction } from "@/lib/types";
import type { MutationResult } from "../actions";
import { useReducedMotion } from "../_hooks/use-reduced-motion";
import {
  exitTransform,
  useSwipeGesture,
  EXIT_MS,
  SWIPE_THRESHOLD,
} from "../_hooks/use-swipe-gesture";
import { SwipeCard } from "./swipe-card";

type Props = {
  cards: CurationCard[];
  // 今日の総ピック数（判定済み込み）。リロード後に判定済みを除外した cards が空でも、
  // 「ピック未生成」と「全件判定済み（完了）」を区別して表示し分けるために使う。
  pickedToday: number;
  // Server Action を prop で受け取る（Next.js のクライアント連携パターン）。
  // fire-and-forget だが失敗を toast で伝えるため戻り値 { ok } を受ける（YAT-41）。
  submitFeedbackAction: (formData: FormData) => Promise<MutationResult>;
  // 「後で読む」お気に入りの付け外し（is_starred トグル）。判定とは別系統で、カードを進めない。
  toggleStarAction: (formData: FormData) => Promise<MutationResult>;
};

// 今日のカードを1枚ずつ捌く Tinder UI。送り操作はクライアント state で楽観的に前進し、
// DB 反映（嗜好更新）は Server Action でバックグラウンド送信する（往復待ちで詰まらせない）。
// ジェスチャーの状態機械は useSwipeGesture に切り出し、ここは描画と Server Action 呼び出しに専念する。
export function CurationDeck({
  cards,
  pickedToday,
  submitFeedbackAction,
  toggleStarAction,
}: Props) {
  const [index, setIndex] = useState(0);
  const [, startTransition] = useTransition();
  const reduced = useReducedMotion();

  // cards はマウント時に固定する。フィードバックの Server Action は（revalidate 有無に関わらず）
  // カレントルートを再レンダーし「判定済みを除外した cards」を渡してくる。これを使うと楽観的に
  // 進める index と二重にズレてカードが飛ぶため、セッション中は初期リストを真実とする。
  // 続き（判定済みの除外）はリロード/再訪時にサーバクエリが行う。
  const [deck] = useState(cards);

  // カウンターの分母は「今日ピックされた総数」に固定する。deck.length（未判定の残り）を分母に
  // すると、3 件判定して再訪したとき 01/07 のように**分母が縮んで**進捗が読めなくなる。
  // 分子には判定済み件数をオフセットとして足す（これが無いと再訪のたびに 01 に戻る）。
  // 分母を定数 10 にしない理由: curate は日次上限 10 を「上限」として使い下限は保証しない
  // （候補枯渇や dedup で 10 件未満になる日がある。lib/ranking/curate.ts）。生成が保証しない値を
  // UI が約束すると、6 件の日に 06/10 で終わって「4 件どこ行った」になる。
  // deck と同じくマウント時に固定する。ライブの pickedToday を読むと、セッション中に「更新」を
  // 押したとき（curate が当日ピックを追加し pickedToday だけ増える）分母だけが膨らみ、
  // 5 枚しか捌いていないのに「全 8 件を見終わりました」と出てしまう。
  const [{ judgedOffset, total }] = useState(() => ({
    judgedOffset: Math.max(0, pickedToday - cards.length),
    total: Math.max(pickedToday, cards.length),
  }));

  // お気に入り状態はクライアントローカルで持つ。toggleStar は /saved のみ revalidate し "/" を
  // 触らないため（デッキの楽観 index を壊さないため）、★の見た目はサーバ再取得に頼らず楽観表示する。
  const [starredIds, setStarredIds] = useState<Set<string>>(
    () => new Set(cards.filter((c) => c.is_starred).map((c) => c.id)),
  );

  const current: CurationCard | undefined = deck[index];
  // 背後に薄く重ねる次の1枚（スタックプレビュー）。最後の1枚では undefined。
  const next: CurationCard | undefined = deck[index + 1];

  // ★トグル: 判定（dismiss/useful）とは別系統。カードは進めず、現在値を送って反転させる。
  // 反転前の値は setStarredIds の updater 内で確定する（クロージャの starredIds を読むと、
  // 高速連打・キーリピート時に stale な値を掴んでサーバ送信と楽観表示が乖離するため）。
  const toggleStar = useCallback(
    (card: CurationCard) => {
      let wasStarred = false;
      setStarredIds((prev) => {
        wasStarred = prev.has(card.id); // updater は直前の最新 state を受けるので連打でも正しい
        const nextSet = new Set(prev);
        if (wasStarred) nextSet.delete(card.id);
        else nextSet.add(card.id);
        return nextSet;
      });
      const fd = new FormData();
      fd.set("id", card.id);
      // toggleStar は現在値を反転する。楽観表示と一致させるため反転前の値を送る。
      fd.set("is_starred", String(wasStarred));
      // 楽観表示は戻さず（★の集計影響はなくリロードで真実に収束する）、失敗のみ toast で伝える。
      startTransition(async () => {
        const r = await toggleStarAction(fd);
        if (!r?.ok)
          toast.error("スターの更新に失敗しました", { id: "star-fail" });
      });
    },
    [toggleStarAction],
  );

  // 楽観前進: フィードバックを送って次の1枚へ。演出は扱わず index を進めるだけ。
  // window.open はここでは呼ばない（ジェスチャー同期で openCard 側が済ませている）。
  const advance = useCallback(
    (card: CurationCard, action: FeedbackAction) => {
      const fd = new FormData();
      fd.set("id", card.id);
      fd.set("action", action);
      // 楽観前進は維持（先に index を進める）。記録失敗は巻き戻さず toast のみ（doc open 参照）。
      startTransition(async () => {
        const r = await submitFeedbackAction(fd);
        if (!r?.ok)
          toast.error("フィードバックの記録に失敗しました", {
            id: "feedback-fail",
          });
      });
      setIndex((i) => i + 1); // 楽観的に次の1枚へ
    },
    [submitFeedbackAction],
  );

  // 送り確定と同期で走る副作用。「開く」の別タブはユーザージェスチャー同期で呼ぶ必要があるため、
  // 送り出し演出（setTimeout）からは切り離してここで即実行する。
  const openCard = useCallback((card: CurationCard, action: FeedbackAction) => {
    if (action === "open" && card.url) {
      window.open(card.url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const { dx, dragging, flyOut, commit, pointerHandlers } = useSwipeGesture({
    current,
    reduced,
    onCommit: openCard,
    onAdvance: advance,
  });

  // キーボード操作: ← 興味なし / → 興味あり / Enter 開く / S お気に入り
  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        commit("dismiss");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        commit("useful");
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit("open");
      } else if (e.key === "s" || e.key === "S") {
        if (e.repeat) return; // 長押しのオートリピートで多重トグルしない
        e.preventDefault();
        toggleStar(current!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, commit, toggleStar]);

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
            ここまで完了です 🎉
            <br />
            今日は{pickedToday}件を判定済み。また明日、新しい候補が届きます。
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
          定期実行で取得されます。「更新」ですぐ取得・生成もできます。
        </p>
      </div>
    );
  }

  if (!current) {
    return (
      <div>
        {sectionLabel(`${String(total).padStart(2, "0")} / ${String(total).padStart(2, "0")}`)}
        <p className="border border-line py-16 text-center text-sm text-muted">
          ここまで完了です 🎉
          <br />
          全{total}件を見終わりました。また明日、新しい候補が届きます。
        </p>
      </div>
    );
  }

  return (
    <div>
      {sectionLabel(
        `${String(judgedOffset + index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}`,
      )}

      <div className="relative touch-pan-y select-none" {...pointerHandlers}>
        {/* idle のスタック覚き（z0）: 背後にずらした「白いカード枠」だけを下に覗かせる。
            本文を出さないので、カードの高さ・本文量が違ってもボタン側へはみ出さず常にクリーン。
            送り出し中も残し、飛んだカードの下から次の1枚がせり上がる「土台」として見せる。 */}
        {next && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 border border-border bg-surface"
            style={{
              zIndex: 0,
              transformOrigin: "top",
              transform: "translateY(6px) scale(0.985)",
            }}
          />
        )}

        {/* current（z2・操作対象）。送り出しは exitTransform で飛ばし、飛び切って index が
            進むと inner が current.id で remount され、entrance が一度だけ再生される。
            「次が来た」感は exit と同時の裏ライズではなく、本物の新カードの着地で見せる。 */}
        <div
          className={`relative ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          style={{
            zIndex: 2,
            transform: flyOut
              ? exitTransform(flyOut)
              : `translateX(${dx}px) rotate(${dx * 0.04}deg)`,
            transition: dragging || reduced ? "none" : `transform ${EXIT_MS}ms ease-out`,
            opacity: flyOut ? 0 : 1,
          }}
        >
          {/* key で current ごとに remount → entrance を一度だけ再生。ドラッグ transform は
              外側 div が持つので、内側の着地アニメ（transform）とは合成され競合しない。 */}
          <div key={current.id} className={reduced ? undefined : "animate-card-enter"}>
            <SwipeCard
              card={current}
              // カード上の通し番号もヘッダのカウンターと同じ基準にする（判定済み分をオフセット）。
              // ここだけ index+1 のままだと、再訪時にヘッダ 04/07 とカード 01 が食い違う。
              index={judgedOffset + index + 1}
              isStarred={starredIds.has(current.id)}
              onToggleStar={() => toggleStar(current)}
            />
          </div>
        </div>

        {/* スワイプ方向のヒント（指の移動量に応じてフェードイン）。
            zIndex はカードラッパー（zIndex: 2）より上に置くこと。position のみ指定して
            z-index を省くと、CSS の描画順で「z-index:auto の positioned 要素」はカードより
            先に描かれ、不透明な bg-surface の裏に完全に隠れる（DOM 順が後でも隠れる）。
            カード自体の追従移動や下部ボタンも方向を示すが、SKIP/KEEP バッジが「今離すとどちらに
            判定されるか」を最も直接に示すので、色でも区別する。色は
            globals.css の negative/positive トークンを使う（a459529 の「色はトークンに集約」方針。
            palette 色を直書きするとダークテーマで追従しない）。accent の赤は OPEN ボタンなど
            一次アクションに予約されているので、判定色は別トークンに分けている。 */}
        <div
          className="pointer-events-none absolute inset-0 flex items-start justify-between p-4"
          style={{ zIndex: 3 }}
        >
          <span
            className="border-2 border-negative px-3 py-1 font-mono text-base font-bold tracking-widest text-negative"
            style={{
              // 送り出し中（flyOut）はヒントを消す。dx を保持したままだとバッジが
              // 飛んでいくカードに残って汚いため。
              opacity: flyOut || dx >= 0 ? 0 : Math.min(1, -dx / SWIPE_THRESHOLD),
              transform: "rotate(-12deg)",
            }}
          >
            SKIP
          </span>
          <span
            className="border-2 border-positive px-3 py-1 font-mono text-base font-bold tracking-widest text-positive"
            style={{
              opacity: flyOut || dx <= 0 ? 0 : Math.min(1, dx / SWIPE_THRESHOLD),
              transform: "rotate(12deg)",
            }}
          >
            KEEP
          </span>
        </div>
      </div>

      <div className="mt-5 flex border border-border divide-x divide-border font-mono text-sm tracking-widest">
        <button
          onClick={() => commit("dismiss")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          ← SKIP
        </button>
        <button
          onClick={() => commit("open")}
          className="flex-1 bg-accent px-4 py-3 font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          OPEN
        </button>
        <button
          onClick={() => commit("useful")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          KEEP →
        </button>
      </div>
    </div>
  );
}
