import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // Marketing copy legitimately uses curly quotes, em-dashes and apostrophes.
      "react/no-unescaped-entities": "off",
    },
    ignores: ["node_modules/**", ".next/**", "out/**", "next-env.d.ts", "dev.log"],
  },
];

export default eslintConfig;
