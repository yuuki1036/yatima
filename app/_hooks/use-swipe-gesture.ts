import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CurationCard, FeedbackAction } from "@/lib/types";

// スワイプで送ると判定する閾値（px）。これを超えて指を離すと dismiss/useful を発火。
export const SWIPE_THRESHOLD = 90;

// 送り出しアニメの所要時間（ms）。この後に index を進めてフィードバックを送る。
export const EXIT_MS = 150;

// 微動をドラッグ扱いしない不感帯（px）。タイトルのタップ（リンク）を温存する。
const DRAG_START_PX = 8;

// カードを送り出す方向。useful=右 / dismiss=左 / open=上 で「どう処理したか」を見せ分ける。
export type ExitDir = "left" | "right" | "up";

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
export function exitTransform(dir: ExitDir): string {
  if (dir === "up") return "translateY(-900px)";
  const sign = dir === "right" ? 1 : -1;
  return `translateX(${sign * 1000}px) rotate(${sign * 18}deg)`;
}

type Params = {
  // 送り出し対象のカード。undefined（完了/未生成）のときは操作を受け付けない。
  current: CurationCard | undefined;
  // OS の「視差効果を減らす」設定。true なら送り出し演出を張らず即前進する。
  reduced: boolean;
  // commit と同期で走る副作用（別タブを開く window.open 等）。ユーザージェスチャー同期で
  // 呼ばれる契約なので、ここに非同期の層を挟まない（挟むとポップアップブロックされうる）。
  onCommit: (card: CurationCard, action: FeedbackAction) => void;
  // 送り出し完了後（reduced 時は即時）に走る前進。フィードバック送信と次の1枚への index 前進を担う。
  onAdvance: (card: CurationCard, action: FeedbackAction) => void;
};

// TODAY デッキの送り出し（スワイプ/キーボード/ボタン）の状態機械を切り出したフック（YAT-52）。
// ドラッグ量・ドラッグ中フラグ・送り出し方向を持ち、閾値超えで commit → 演出 → onAdvance と流す。
// 描画とフィードバックの Server Action 呼び出しは呼び出し側に残す（このフックは動きだけを持つ）。
export function useSwipeGesture({
  current,
  reduced,
  onCommit,
  onAdvance,
}: Params) {
  // ── 送り出し（スワイプ）の状態 ───────────────────────────────
  // ドラッグ量・ドラッグ中フラグ・送り出し方向。flyOut が立つと演出が走り、終端で advance する。
  const [dx, setDx] = useState(0); // 現在のドラッグ量（px）
  const [dragging, setDragging] = useState(false);
  const [flyOut, setFlyOut] = useState<ExitDir | null>(null);
  const dragStartX = useRef(0);
  const pointerActive = useRef(false);
  const draggingRef = useRef(false); // 判定は ref で行う（state クロージャの陳腐化を避ける）
  const dxRef = useRef(0);

  const resetDrag = useCallback(() => {
    dxRef.current = 0;
    setDx(0);
  }, []);

  // 全入力経路（ボタン / キーボード / ドラッグ確定）の共通入口。送り出し演出を起こし、
  // 終端で onAdvance する。reduced-motion 時は演出もタイマーも張らず即前進。
  const commit = useCallback(
    (action: FeedbackAction) => {
      if (!current || flyOut) return; // 演出中・対象なしは多重発火させない
      // 「開く」の別タブ等はユーザージェスチャー同期で呼ぶ。150ms の setTimeout 経由に
      // 乗せるとポップアップブロックされうるため、演出の遅延からは切り離す。
      onCommit(current, action);
      if (reduced) {
        onAdvance(current, action); // 演出なしで即前進（ドラッグ残量もここで戻す）
        resetDrag();
        return;
      }
      setFlyOut(ACTION_DIR[action]);
    },
    [current, flyOut, reduced, onCommit, onAdvance, resetDrag],
  );

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
      if (Math.abs(d) < DRAG_START_PX) return; // 微動はドラッグ扱いせずタップを温存
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
    if (d > SWIPE_THRESHOLD) commit("useful");
    else if (d < -SWIPE_THRESHOLD) commit("dismiss");
    else resetDrag();
  }, [commit, resetDrag]);

  // 飛ばし切ったらフィードバックを送って次の1枚へ（送り出しアニメ後に発火）。
  // reduced 時は commit が即 onAdvance するため flyOut は立たず、この effect は走らない。
  useEffect(() => {
    if (!flyOut || !current) return;
    const t = setTimeout(() => {
      onAdvance(current, DIR_ACTION[flyOut]);
      resetDrag();
      setFlyOut(null);
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [flyOut, current, onAdvance, resetDrag]);

  return {
    dx,
    dragging,
    flyOut,
    // ボタン/キーボードからも同じ入口を使う。
    commit,
    // カードのコンテナ div にそのまま展開する。
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
