'use strict';

module.exports = [{
    ignores: [
        'dist/**',
        'index.css',
        'node_modules/**',
        'vendor/**'
    ]
}, {
    files: ['*.js'],
    languageOptions: {
        ecmaVersion: 2022,
        sourceType: 'commonjs',
        globals: {
            Buffer: 'readonly',
            SBar: 'readonly',
            __dirname: 'readonly',
            clearInterval: 'readonly',
            clearTimeout: 'readonly',
            console: 'readonly',
            document: 'readonly',
            fancy: 'readonly',
            module: 'readonly',
            navigator: 'readonly',
            process: 'readonly',
            requestAnimationFrame: 'readonly',
            require: 'readonly',
            setInterval: 'readonly',
            setTimeout: 'readonly',
            window: 'readonly',
            $: 'readonly'
        }
    },
    rules: {
        curly: ['error', 'all'],
        eqeqeq: ['error', 'always'],
        indent: ['error', 4, {SwitchCase: 1}],
        'no-undef': 'error',
        'no-unused-vars': ['error', {args: 'none'}],
        quotes: ['error', 'single', {allowTemplateLiterals: true}],
        semi: ['error', 'always']
    }
}];
