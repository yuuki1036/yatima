"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { toast } from "sonner";
import type { CurationCard, FeedbackAction } from "@/lib/types";
import type { MutationResult } from "../actions";
import { useReducedMotion } from "../_hooks/use-reduced-motion";
import { SwipeCard } from "./swipe-card";

// スワイプで送ると判定する閾値（px）。これを超えて指を離すと dismiss/useful を発火。
const SWIPE_THRESHOLD = 90;

// 送り出しアニメの所要時間（ms）。この後に index を進めてフィードバックを送る。
const EXIT_MS = 150;

// カードを送り出す方向。useful=右 / dismiss=左 / open=上 で「どう処理したか」を見せ分ける。
type ExitDir = "left" | "right" | "up";

// 判定アクションと送り出し方向の対応。両引きできるよう双方向で持つ。
// satisfies Record<FeedbackAction, ExitDir> でキーの過不足を型に守らせる
// （FeedbackAction が増減したらここがコンパイルエラーになり気づける）。
const ACTION_DIR = {
  dismiss: "left",
  useful: "right",
  open: "up",
} as const satisfies Record<FeedbackAction, ExitDir>;

const DIR_ACTION: Record<ExitDir, FeedbackAction> = {
  left: "dismiss",
  right: "useful",
  up: "open",
};

// 送り出し中の transform。上抜け（open）は回転なしで真上へ、左右は回しながら飛ばす。
function exitTransform(dir: ExitDir): string {
  if (dir === "up") return "translateY(-900px)";
  const sign = dir === "right" ? 1 : -1;
  return `translateX(${sign * 1000}px) rotate(${sign * 18}deg)`;
}

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
        const next = new Set(prev);
        if (wasStarred) next.delete(card.id);
        else next.add(card.id);
        return next;
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

  // ── 送り出し（スワイプ）の状態 ───────────────────────────────
  // ドラッグ量・ドラッグ中フラグ・送り出し方向。flyOut が立つと演出が走り、終端で advance する。
  const [dx, setDx] = useState(0); // 現在のドラッグ量（px）
  const [dragging, setDragging] = useState(false);
  const [flyOut, setFlyOut] = useState<ExitDir | null>(null);
  const dragStartX = useRef(0);
  const pointerActive = useRef(false);
  const draggingRef = useRef(false); // 判定は ref で行う（state クロージャの陳腐化を避ける）
  const dxRef = useRef(0);

  // 楽観前進: フィードバックを送って次の1枚へ。演出は扱わず index を進めるだけ。
  // window.open はここでは呼ばない（ジェスチャー同期で commit 側が済ませている）。
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

  // 全入力経路（ボタン / キーボード / ドラッグ確定）の共通入口。送り出し演出を起こし、
  // 終端で advance する。reduced-motion 時は演出もタイマーも張らず即 advance。
  const commit = useCallback(
    (card: CurationCard, action: FeedbackAction) => {
      if (flyOut) return; // 演出中は多重発火させない
      // 「開く」の別タブはユーザージェスチャー同期で呼ぶ。150ms の setTimeout 経由に
      // 乗せるとポップアップブロックされうるため、演出の遅延からは切り離す。
      if (action === "open" && card.url) {
        window.open(card.url, "_blank", "noopener,noreferrer");
      }
      if (reduced) {
        advance(card, action); // 演出なしで即前進（ドラッグ残量もここで戻す）
        dxRef.current = 0;
        setDx(0);
        return;
      }
      setFlyOut(ACTION_DIR[action]);
    },
    [flyOut, reduced, advance],
  );

  // キーボード操作: ← 興味なし / → 興味あり / Enter 開く / S お気に入り
  useEffect(() => {
    if (!current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        commit(current!, "dismiss");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        commit(current!, "useful");
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit(current!, "open");
      } else if (e.key === "s" || e.key === "S") {
        if (e.repeat) return; // 長押しのオートリピートで多重トグルしない
        e.preventDefault();
        toggleStar(current!);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, commit, toggleStar]);

  // ── フリック（スワイプ）対応: カードを左右にドラッグして送る ─────────────
  // ポインタ操作（タッチ + マウス兼用）。8px 動いて初めてドラッグ扱いにし、タイトルの
  // タップ（リンク）を温存する。閾値超えで dismiss/useful を発火。

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
    // 閾値超えは commit に流して送り出し（reduced 時は即前進）。未満はスナップバック。
    if (current && d > SWIPE_THRESHOLD) commit(current, "useful");
    else if (current && d < -SWIPE_THRESHOLD) commit(current, "dismiss");
    else {
      dxRef.current = 0;
      setDx(0);
    }
  }, [commit, current]);

  // 飛ばし切ったらフィードバックを送って次の1枚へ（送り出しアニメ後に発火）。
  // reduced 時は commit が即 advance するため flyOut は立たず、この effect は走らない。
  useEffect(() => {
    if (!flyOut || !current) return;
    const t = setTimeout(() => {
      advance(current, DIR_ACTION[flyOut]);
      dxRef.current = 0;
      setDx(0);
      setFlyOut(null);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [flyOut, current, advance]);

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
            今日は{pickedToday}件を判定済み。「更新」で次の候補を出せます。
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
        {sectionLabel(`${deck.length} / ${deck.length}`)}
        <p className="border border-line py-16 text-center text-sm text-muted">
          ここまで完了です 🎉
          <br />
          全{deck.length}件を見終わりました。「更新」で次の候補を出せます。
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
              index={index + 1}
              isStarred={starredIds.has(current.id)}
              onToggleStar={() => toggleStar(current)}
            />
          </div>
        </div>

        {/* スワイプ方向のヒント（指の移動量に応じてフェードイン） */}
        <div className="pointer-events-none absolute inset-0 flex items-start justify-between p-4">
          <span
            className="border-2 border-border px-3 py-1 font-mono text-base font-bold tracking-widest text-foreground"
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
            className="border-2 border-accent px-3 py-1 font-mono text-base font-bold tracking-widest text-accent"
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
          onClick={() => commit(current, "dismiss")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          ← SKIP
        </button>
        <button
          onClick={() => commit(current, "open")}
          className="flex-1 bg-accent px-4 py-3 font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          OPEN
        </button>
        <button
          onClick={() => commit(current, "useful")}
          className="flex-1 px-4 py-3 transition-colors hover:bg-foreground hover:text-background"
        >
          KEEP →
        </button>
      </div>
    </div>
  );
}
