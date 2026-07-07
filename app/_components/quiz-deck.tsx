"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { QuizQuestion, QuizSessionResult } from "@/lib/types";

// YAT-27: 適応クイズの選択式デッキ（MVP）。カテゴリ選択 → オンデマンド生成 → 1問1画面で
// 即時採点＋解説 → 回答記録（fire-and-forget）。curation-deck.tsx の「client state で楽観前進・
// Server Action はバックグラウンド送信」の操作モデルを選択式に写す。適応選定・弱点マップは YAT-28。

type Category = { slug: string; label: string };

type Props = {
  categories: Category[]; // tech/* leaf（おまかせは slug="" で末尾に添える）
  startAction: (categoryRaw: string) => Promise<QuizSessionResult>;
  answerAction: (questionId: string, chosenIndex: number) => void;
  masterySlot?: React.ReactNode; // YAT-28: picker phase 下に差し込む弱点マップ（Server Component）
  sourcesSlot?: React.ReactNode; // YAT-32: picker phase 下に差し込む学習ソース管理（Server Component）
};

const DIFF_LABEL = {
  easy: "EASY",
  medium: "MEDIUM",
  hard: "HARD",
} as const satisfies Record<QuizQuestion["difficulty"], string>;

export function QuizDeck({
  categories,
  startAction,
  answerAction,
  masterySlot,
  sourcesSlot,
}: Props) {
  const [phase, setPhase] = useState<"picker" | "quiz" | "done">("picker");
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [correctCount, setCorrectCount] = useState(0);

  const current: QuizQuestion | undefined = questions[index];

  // カテゴリを選んでセッション開始。生成に時間がかかるため useTransition で pending を出す。
  const start = useCallback(
    (slug: string) => {
      setNote(null);
      startTransition(async () => {
        const res = await startAction(slug);
        if (res.questions.length === 0) {
          setNote(res.note ?? "出題を用意できませんでした。");
          return;
        }
        setQuestions(res.questions);
        setIndex(0);
        setSelected(null);
        setCorrectCount(0);
        setPhase("quiz");
      });
    },
    [startAction],
  );

  // 選択肢を選ぶ: 即時採点（answer_index と比較）＋回答記録（fire-and-forget）。二重回答は無視。
  const choose = useCallback(
    (choiceIndex: number) => {
      if (!current || selected !== null) return;
      setSelected(choiceIndex);
      if (choiceIndex === current.answer_index) setCorrectCount((n) => n + 1);
      startTransition(() => answerAction(current.id, choiceIndex));
    },
    [current, selected, answerAction],
  );

  // 次の1問へ（最後なら結果へ）。
  const next = useCallback(() => {
    if (selected === null) return;
    if (index + 1 >= questions.length) {
      setPhase("done");
      return;
    }
    setIndex((i) => i + 1);
    setSelected(null);
  }, [selected, index, questions.length]);

  // キーボード: 1〜4 で選択 / Enter で次へ。
  useEffect(() => {
    if (phase !== "quiz") return;
    function onKey(e: KeyboardEvent) {
      if (e.key >= "1" && e.key <= "4") {
        e.preventDefault();
        choose(Number(e.key) - 1);
      } else if (e.key === "Enter" && selected !== null) {
        e.preventDefault();
        next();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, choose, next, selected]);

  const sectionLabel = (right?: string) => (
    <div className="mb-5 flex items-baseline justify-between">
      <span className="font-mono text-xs font-medium tracking-widest text-accent">
        QUIZ
      </span>
      {right && (
        <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
          {right}
        </span>
      )}
    </div>
  );

  // ── カテゴリ選択 ─────────────────────────────────────
  if (phase === "picker") {
    return (
      <div>
        {sectionLabel()}
        <p className="mb-6 text-xs text-muted">
          カテゴリを選ぶと、承認した学習ソース（公式 docs・定番解説）から4択クイズを出題します。選択式で気軽に。
        </p>

        {note && (
          <div className="mb-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
            {note}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {categories.map((c) => (
            <button
              key={c.slug || "any"}
              onClick={() => start(c.slug)}
              disabled={pending}
              className="border border-border px-3 py-3 text-left font-mono text-xs tracking-wide transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {c.label}
            </button>
          ))}
        </div>

        {pending && (
          <p className="mt-6 text-center font-mono text-xs tracking-widest text-muted">
            生成中…（数秒かかります）
          </p>
        )}

        {masterySlot}
        {sourcesSlot}
      </div>
    );
  }

  // ── 結果 ────────────────────────────────────────────
  if (phase === "done") {
    return (
      <div>
        {sectionLabel()}
        <div className="border border-line py-12 text-center">
          <p className="font-mono text-3xl font-bold tabular-nums text-foreground">
            {correctCount} / {questions.length}
          </p>
          <p className="mt-2 text-sm text-muted">正解しました 🎉</p>
        </div>
        <button
          onClick={() => setPhase("picker")}
          className="mt-4 w-full border border-border px-4 py-3 font-mono text-sm tracking-widest transition-colors hover:bg-foreground hover:text-background"
        >
          もう一度
        </button>
      </div>
    );
  }

  // ── 出題（quiz） ────────────────────────────────────
  if (!current) return null;
  const answered = selected !== null;

  return (
    <div>
      {sectionLabel(
        `${String(index + 1).padStart(2, "0")} / ${String(questions.length).padStart(2, "0")}`,
      )}

      <div className="border border-border bg-surface p-5">
        <div className="mb-3 flex items-center gap-2 font-mono text-xs tracking-widest text-faint">
          <span className="text-muted">{current.concept_label}</span>
          <span>· {DIFF_LABEL[current.difficulty]}</span>
        </div>

        <p className="mb-5 whitespace-pre-wrap font-medium leading-relaxed">
          {current.stem}
        </p>

        <div className="flex flex-col gap-2">
          {current.choices.map((choice, i) => {
            const isAnswer = i === current.answer_index;
            const isChosen = i === selected;
            // 回答後の見せ分け: 正解=accent / 選んだ誤答=取り消し線 / それ以外=減光。
            let cls =
              "border border-border px-4 py-3 text-left text-sm transition-colors";
            if (!answered) {
              cls += " hover:bg-foreground hover:text-background";
            } else if (isAnswer) {
              cls += " border-accent bg-accent text-accent-foreground";
            } else if (isChosen) {
              cls += " text-muted line-through";
            } else {
              cls += " text-faint";
            }
            return (
              <button
                key={i}
                onClick={() => choose(i)}
                disabled={answered}
                className={cls}
              >
                {/* 正誤は色だけに頼らず記号でも示す（色覚差配慮・回答後の一目瞭然）。 */}
                {answered && isAnswer && (
                  <span aria-label="正解" className="mr-1 font-bold">
                    ✓
                  </span>
                )}
                {answered && isChosen && !isAnswer && (
                  <span aria-label="不正解" className="mr-1 font-bold">
                    ✗
                  </span>
                )}
                <span className="mr-2 font-mono text-xs text-faint">
                  {i + 1}
                </span>
                {choice}
              </button>
            );
          })}
        </div>

        {answered && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-sm text-foreground">{current.explanation}</p>
            {current.source_quote && (
              <p className="mt-3 border-l-2 border-line pl-2 text-xs text-faint">
                {current.source_quote}
              </p>
            )}
          </div>
        )}
      </div>

      <button
        onClick={next}
        disabled={!answered}
        className="mt-4 w-full border border-border px-4 py-3 font-mono text-sm tracking-widest transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        {index + 1 >= questions.length ? "結果へ →" : "次へ →"}
      </button>
    </div>
  );
}
