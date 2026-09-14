import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
export default tseslint.config({ ignores: ['src/generated/**'] }, js.configs.recommended, ...tseslint.configs.recommended, {files:['src/**/*.{ts,tsx}'],languageOptions:{globals:{...globals.browser,...globals.worker}},plugins:{'react-hooks':hooks},rules:{...hooks.configs.recommended.rules,'@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_'}]}});
