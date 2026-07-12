"use client"; // error boundary は Client Component 必須

import { useEffect } from "react";

// ルートセグメントの error boundary（YAT-40）。loading.tsx で page が Suspense ラップされると
// errored セグメントのフォールバックが要るため対で置く。全ページ force-dynamic でサーバのデータ
// 取得エラーが主因のため、error state のクリアだけの reset ではなく再フェッチ＋再レンダーする
// unstable_retry を使う（Next.js 16.2 で追加・docs 推奨。`node_modules/next/dist/docs/.../error.md`）。
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="border border-border bg-surface px-6 py-16 text-center">
      <p className="font-mono text-xs font-medium tracking-widest text-accent">
        ERROR
      </p>
      <p className="mt-3 text-sm text-muted">
        表示中に問題が発生しました。時間をおいて再試行してください。
      </p>
      <button
        onClick={() => unstable_retry()}
        className="mt-6 border border-border px-4 py-2 font-mono text-sm tracking-widest transition-colors hover:bg-foreground hover:text-background"
      >
        再試行
      </button>
    </div>
  );
}
