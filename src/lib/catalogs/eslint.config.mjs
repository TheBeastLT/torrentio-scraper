import globals from 'globals';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/** @type {import('eslint').Linter.Config[]} */
export default [
	js.configs.all,
	...tseslint.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		}
	},
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tseslint.parser
		},
		plugins: {
			...tseslint.configs.recommended,
		}
	},
	{
		rules: {
			camelcase: 'off',
			'max-lines-per-function': 'off',
			'max-statements': 'off',
			'new-cap': 'off',
			'no-magic-numbers': 'off',
			'one-var': 'off',
			'id-length': 'off',
			'sort-vars': 'off',
			'max-classes-per-file': 'off',
			'func-style': 'off',
			'no-ternary': 'off',
			'sort-imports': 'off',
			'sort-keys': 'off',
			'max-lines': 'off',
			'no-undefined': 'off',
			complexity: 'warn',
			'no-plusplus': 'off',
			'prefer-const': 'off',
			'prefer-destructuring': 'off',
			'require-atomic-updates': 'off',
			'capitalized-comments': 'off',
			'no-await-in-loop': 'off',
			'no-undef-init': 'off',
			'init-declarations': 'off',
			'dot-notation': 'off',
			'no-console': 'off',
			'no-inline-comments': 'off'
		}
	},
	{
		ignores: ['build/', 'dist/', 'express/dist', 'node_modules/', 'src/lib/api-spec.ts']
	}
];
