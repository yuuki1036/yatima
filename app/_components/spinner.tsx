// 汎用スピナー。色は currentColor で親の text 色を継承し、大きさは className（既定 size-4）で調整する。
// サイズ未指定の inline SVG は既定 300×150px に膨らむ（Tailwind preflight もサイズは付けない）ため、
// 素の <Spinner /> でも壊れないよう既定サイズを持たせる。状態は呼び出し側のラベル（loading の
// role="status" やボタンの pending 文言）で伝えるので、スピナー自体は aria-hidden の装飾扱いにして
// SR の二重読み上げを避ける。回転抑制は CSS のみ（animate-spin motion-reduce:animate-none）で行い、
// reduced-motion 判定の JS フックは持ち込まない。YAT-40 の loading／以降の SubmitButton で共用する。
export function Spinner({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-90"
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
