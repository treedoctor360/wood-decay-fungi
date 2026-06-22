import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// GitHub Pages のリポジトリ名に合わせた設定
// base の値 = GitHubリポジトリ名(前後のスラッシュを含む)
export default defineConfig({
  base: "/wood-decay-fungi/",
  plugins: [react()],
});
