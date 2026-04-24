// 导入 ESLint 的JS官方规则集
import js_rules_by_eslint from "@eslint/js";
// 导入 prettier 的冲突消除配置，关闭所有 ESLint 中，与 prettier 格式化重叠的规则
import disable_rules_conflict_with_prettier from "eslint-config-prettier";
import globals from "globals";

// Flat Config 的固定格式，导出一个数组，数组中的每一项都是一层配置，按顺序进行叠加
export default [
    js_rules_by_eslint.configs.recommended,
    disable_rules_conflict_with_prettier,
    {
        rules: {
            "no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                },
            ],
        },
    },
    {
        // 仅适用于 .mjs 文件（ESM）和 .js 文件
        // .js 文件通过 package.json 的 "type": "module" 属性，同样被视为 ESM
        files: ["**/*.mjs", "**/*.js"],
        languageOptions: {
            globals: {
                // 不含 CJS 的 require/module 等特殊全局 API
                ...globals.nodeBuiltin,
            },
        },
    },
    {
        // 仅适用于 .cjs 文件（CommonJS）
        files: ["**/*.cjs"],
        languageOptions: {
            globals: {
                // 含 require/module/exports，适合 CJS 文件
                ...globals.node,
            },
        },
    },
];
