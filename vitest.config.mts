import { defineConfig } from "vitest/config";

// コアロジック（lib/ 配下の純関数）のユニットテスト設定（YAT-46）。
// React コンポーネントは対象外のため jsdom/@testing-library は入れず、node 環境で走らせる。
// `@/` エイリアスは Vite ネイティブの tsconfig paths 解決で扱う。
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
  },
});
