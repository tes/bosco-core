module.exports = {
  env: {
    browser: false,
    commonjs: true,
    es6: false,
  },
  extends: [
    'airbnb-base',
  ],
  globals: {
    Atomics: 'readonly',
    SharedArrayBuffer: 'readonly',
  },
  parserOptions: {
    ecmaVersion: 2018,
  },
  rules: {
    "no-underscore-dangle": 0,
    "consistent-return": 0,
  },
};
