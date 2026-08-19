// eslint-config-next ships native flat configs as of Next 16 — no FlatCompat.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts"] },
  ...coreWebVitals,
  ...typescript,
];

export default config;
