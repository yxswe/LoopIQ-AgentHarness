import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		exclude: ["dist/**", "node_modules/**"],
		testTimeout: 30000, // 30 seconds for API calls
	},
	resolve: {
		alias: [
			{ find: /^@loopiq\/ai$/, replacement: aiSrcIndex },
			{ find: /^@loopiq\/ai\/compat$/, replacement: aiSrcCompat },
		],
	},
});
