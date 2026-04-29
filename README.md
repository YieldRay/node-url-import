# nodejs-minimal-ts-template

A minimal TypeScript starter for Node.js (Node >= 22 and TypeScript >= 5.8).

For small apps or microservices you often don't need extra runtime/dev tools like `ts-node`, `tsx`, `nodemon`, `dotenv`, `chalk`, `commander`, `yargs`, `mocha`, or `jest`.
Modern Node and TypeScript provide enough primitives to keep projects lean.

This template uses Node's `--experimental-transform-types` together with TypeScript's `--erasableSyntaxOnly` to run TypeScript code directly with Node.js without any external dependencies.

See also:

- [Do I need this node dependency?](https://brianmuenzenmeyer.com/posts/2024-do-i-need-this-node-dependency/)
- Node flag [--experimental-transform-types](https://nodejs.org/api/cli.html#--experimental-transform-types)
- TypeScript flag [--erasableSyntaxOnly](https://devblogs.microsoft.com/typescript/announcing-typescript-5-8/#the---erasablesyntaxonly-option)

Quick start:

```sh
# create .env file
touch .env
# install deps
npm i
```

Also see the plain-JS template: [nodejs-pure-js-template](https://github.com/YieldRay/nodejs-pure-js-template).
