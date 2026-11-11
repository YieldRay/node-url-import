import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { fetchModule } from "./fetch.ts";
import { cachePaths, decodeModuleSource, readCache, writeCache, writeFileAtomicSync } from "./cache.ts";

const requests: string[] = [];
const wasmBytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0,
  7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11,
  0, 3, 1, 120, 255,
]);
const encodedText = 'export default "café";\n';
const encodedSources = [
  { path: "/encoding/latin1.mjs", contentType: "application/javascript; charset=iso-8859-1", bytes: Buffer.from(encodedText, "latin1") },
  { path: "/encoding/utf16le.mjs", contentType: 'application/javascript; CHARSET="utf-16le"', bytes: Buffer.concat([Buffer.from([255, 254]), Buffer.from(encodedText, "utf16le")]) },
  { path: "/encoding/utf16be.mjs", contentType: "application/javascript; charset=utf-16be", bytes: Buffer.concat([Buffer.from([254, 255]), Buffer.from(encodedText, "utf16le").swap16()]) },
  { path: "/encoding/bom.mjs", contentType: "application/javascript", bytes: Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(encodedText)]) },
];
const server = createServer((request, response) => {
  requests.push(request.url!);
  const encoded = encodedSources.find((entry) => entry.path === request.url);
  if (encoded) {
    response.setHeader("Content-Type", encoded.contentType);
    response.end(encoded.bytes);
    return;
  }
  if (request.url === "/missing.mjs") {
    response.writeHead(404).end();
    return;
  }
  if (request.url?.startsWith("/redirect/")) {
    const count = Number(request.url.slice("/redirect/".length));
    if (count > 0) {
      response.writeHead(302, { Location: `/redirect/${count - 1}` }).end();
      return;
    }
  }
  if (request.url === "/fragment-redirect") {
    response.writeHead(302, { Location: "/fragment-target.mjs" }).end();
    return;
  }
  if (request.url === "/fragment-replaced") {
    response.writeHead(302, { Location: "/replaced-target.mjs#replacement" }).end();
    return;
  }
  if (request.url === "/fragment-cleared") {
    response.writeHead(302, { Location: "/cleared-target.mjs#" }).end();
    return;
  }
  if (request.url === "/cancelled.mjs") {
    response.writeHead(200, { "Content-Type": "application/javascript" });
    response.flushHeaders();
    return;
  }
  if (request.url === "/invalid-redirect") {
    response.writeHead(302, { Location: "data:text/javascript,export default 42" }).end();
    return;
  }
  if (request.url === "/binary.wasm") {
    response.setHeader("Content-Type", "application/wasm");
    response.end(wasmBytes);
    return;
  }
  response.setHeader("Content-Type", "application/javascript");
  response.end(request.url === "/empty.mjs" ? "" : `export default ${JSON.stringify(request.url)};`);
});
let baseUrl: string;

function runAuthChild(program: string, authTokens?: string, reload = false, lockFile = false) {
  const directory = mkdtempSync(join(tmpdir(), "node-url-import-auth-test-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DENO_DIR: join(directory, "deno"),
      URL_IMPORT_RELOAD: reload ? "1" : "0",
      URL_IMPORT_LOCK: lockFile ? join(directory, "deno.lock") : "",
      URL_IMPORT_FROZEN: "0",
      FORCE_COLOR: "0",
    };
    if (authTokens === undefined) delete env.DENO_AUTH_TOKENS;
    else env.DENO_AUTH_TOKENS = authTokens;
    return spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      timeout: 15_000,
      env,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => { requests.length = 0; });
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(cachePaths(baseUrl).dir, { recursive: true, force: true });
});

describe("fetchModule", () => {
  it("matches DENO_AUTH_TOKENS at the HTTP boundary", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};

      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), authorization: new Headers(options.headers).get("authorization") });
        return new Response("export default 1;", { headers: { "content-type": "application/javascript" } });
      };
      const cases = [
        ["https://api.example.test/module.mjs", "https://api.example.test/module.mjs", "Bearer domain-token"],
        ["https://sub.api.example.test/module.mjs", "https://sub.api.example.test/module.mjs", "Bearer domain-token"],
        ["https://notapi.example.test/module.mjs", "https://notapi.example.test/module.mjs", undefined],
        ["https://api.example.test.evil/module.mjs", "https://api.example.test.evil/module.mjs", undefined],
        ["https://notexample.test/module.mjs", "https://notexample.test/module.mjs", undefined],
        ["https://at.test/module.mjs", "https://at.test/module.mjs", "Bearer last@token"],
        ["https://basic.test/module.mjs", "https://basic.test/module.mjs", "Basic YmFzaWM6d2l0aDpjb2xvbnM="],
        ["https://first.test/module.mjs", "https://first.test/module.mjs", "Bearer first-match"],
        ["https://child.first.test/module.mjs", "https://child.first.test/module.mjs", "Bearer first-match"],
        ["https://port.test/module.mjs", "https://port.test/module.mjs", undefined],
        ["https://port.test:443/module.mjs", "https://port.test/module.mjs", undefined],
        ["https://port.test:8080/module.mjs", "https://port.test:8080/module.mjs", "Bearer custom-port"],
        ["https://port.test:8081/module.mjs", "https://port.test:8081/module.mjs", undefined],
        ["http://127.0.0.1/module.mjs", "http://127.0.0.1/module.mjs", "Bearer ipv4"],
        ["http://127.0.0.1.example.test/module.mjs", "http://127.0.0.1.example.test/module.mjs", undefined],
        ["http://127.0.0.2/module.mjs", "http://127.0.0.2/module.mjs", undefined],
        ["http://127.000.0.1/module.mjs", "http://127.0.0.1/module.mjs", "Bearer ipv4"],
        ["http://[2001:db8::1]/module.mjs", "http://[2001:db8::1]/module.mjs", "Bearer ipv6"],
        ["http://[2001:0db8:0:0:0:0:0:1]/module.mjs", "http://[2001:db8::1]/module.mjs", "Bearer ipv6"],
        ["http://[2001:db8::2]/module.mjs", "http://[2001:db8::2]/module.mjs", "Bearer ipv6-other"],
        ["http://[2001:db8::2]:8080/module.mjs", "http://[2001:db8::2]:8080/module.mjs", "Bearer ipv6-port"],
        ["https://untrimmed.test/module.mjs", "https://untrimmed.test/module.mjs", undefined],
        ["https://tail.test/module.mjs", "https://tail.test/module.mjs", "Bearer tail"],
        ["https://malformed.test/module.mjs", "https://malformed.test/module.mjs", undefined],
        ["https://unconfigured.test/module.mjs", "https://unconfigured.test/module.mjs", undefined],
      ];
      for (const [input] of cases) await fetchModule(input);
      assert.deepEqual(calls.map(({ url, authorization }) => [url, authorization ?? undefined]),
        cases.map(([, url, authorization]) => [url, authorization]));

      await assert.rejects(fetchModule("https://control.example.test/module.mjs"), (error) => {
        assert.equal(error.message, "Invalid Authorization header in DENO_AUTH_TOKENS");
        assert.doesNotMatch(error.message, /private\\ncredential/);
        return true;
      });
      assert.equal(calls.length, cases.length);
    `;
    const authTokens = `\n${[
      "domain-token@.API.EXAMPLE.TEST",
      "last@token@at.test",
      "basic:with:colons@basic.test",
      "first-match@first.test",
      "second-match@child.first.test",
      "default-port@port.test:443",
      "custom-port@port.test:8080",
      "ipv4@127.0.0.1",
      "invalid-ipv4@127.000.0.2",
      "ipv6@[2001:db8::1]",
      "ipv6-other@[2001:db8::2]",
      "ipv6-port@[2001:db8::2]:8080",
      "untrimmed@ untrimmed.test ",
      "tail@tail.test",
      "malformed.test",
      "private\ncredential@control.example.test",
    ].join(";")}\t`;
    const child = runAuthChild(program, authTokens, true);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    assert.doesNotMatch(child.stderr, /last@token|basic:with:colons|domain-token|private\ncredential/);
    assert.match(child.stderr, /Badly formed auth token discarded/);
  });

  it("reuses authenticated cache entries without another request", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      import { readCache } from ${JSON.stringify(new URL("./cache.ts", import.meta.url).href)};
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), authorization: new Headers(options.headers).get("authorization") });
        return new Response("export default 1;", { headers: { "content-type": "application/javascript" } });
      };
      const url = "https://cache-auth.example.test/cached.mjs";
      const first = await fetchModule(url);
      const second = await fetchModule(url);
      assert.deepEqual(second, first);
      assert.deepEqual(calls, [{ url, authorization: "Bearer cached" }]);
      assert.ok(readCache(url));
    `;
    const child = runAuthChild(program, "cached@cache-auth.example.test");
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    assert.doesNotMatch(child.stderr, /cached/);
  });

  it("does not add credentials when DENO_AUTH_TOKENS was unset at module startup", () => {
    const program = `
      import assert from "node:assert/strict";
      import process from "node:process";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push(new Headers(options.headers).get("authorization"));
        return new Response("export default 1;", { headers: { "content-type": "application/javascript" } });
      };
      process.env.DENO_AUTH_TOKENS = "late@unset.example.test";
      await fetchModule("https://unset.example.test/module.mjs");
      assert.deepEqual(calls, [null]);
    `;
    const child = runAuthChild(program);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  });

  it("does not cache failed authenticated responses", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      import { readCache } from ${JSON.stringify(new URL("./cache.ts", import.meta.url).href)};
      const url = "https://private.example.test/failures.mjs";
      let requests = 0;
      globalThis.fetch = async (_url, options) => {
        assert.equal(new Headers(options.headers).get("authorization"), "Bearer private-token");
        requests++;
        if (requests === 1) return new Response("denied", { status: 401, statusText: "Unauthorized" });
        if (requests === 2) return new Response("missing", { status: 404, statusText: "Not Found" });
        return new Response("export default 42;", { headers: { "content-type": "application/javascript" } });
      };
      await assert.rejects(fetchModule(url), /401 Unauthorized/);
      assert.equal(readCache(url), null);
      await assert.rejects(fetchModule(url), /404 Not Found/);
      assert.equal(readCache(url), null);
      assert.equal((await fetchModule(url)).source, "export default 42;");
      assert.ok(readCache(url));
      assert.equal(requests, 3);
    `;
    const child = runAuthChild(program, "private-token@private.example.test");
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
    assert.doesNotMatch(child.stderr, /private-token/);
  });

  it("accepts HeadersInit forms and lets explicit headers override defaults and auth tokens", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), headers: new Headers(options.headers) });
        return new Response("export default 1;", { headers: { "content-type": "application/javascript" } });
      };
      const headers = new Headers([["X-Request", "headers-instance"]]);
      await fetchModule("https://headers.example.test/record.mjs", {
        headers: { "User-Agent": "caller-agent", "X-Request": "record", Authorization: "Basic caller" },
      });
      await fetchModule("https://headers.example.test/tuples.mjs", {
        headers: [["X-Request", "tuples"]],
      });
      await fetchModule("https://headers.example.test/headers.mjs", { headers });
      assert.deepEqual(calls.map(({ headers }) => [
        headers.get("user-agent"), headers.get("x-request"), headers.get("authorization"),
      ]), [
        ["caller-agent", "record", "Basic caller"],
        ["node-url-import", "tuples", "Bearer configured-token"],
        ["node-url-import", "headers-instance", "Bearer configured-token"],
      ]);
      assert.equal(headers.get("authorization"), null);
      assert.equal(headers.get("user-agent"), null);
    `;
    const child = runAuthChild(program, "configured-token@headers.example.test", true);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  });

  it("validates timeout and headers options even on cache hits", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      import { writeCache } from ${JSON.stringify(new URL("./cache.ts", import.meta.url).href)};
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        return new Response("export default 1;", {
          headers: { "content-type": "application/javascript" },
        });
      };
      const url = "https://timeout.example.test/module.mjs";
      writeCache([url], "export default 1;", "application/javascript");
      for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
        await assert.rejects(fetchModule(url, { timeoutMs }), {
          name: "RangeError",
          message: "The fetch timeout must be a positive integer no greater than 2147483647",
        });
      }
      await assert.rejects(fetchModule(url, { headers: [["invalid header name", "value"]] }), TypeError);
      assert.equal((await fetchModule(url, { timeoutMs: 2147483647 })).source, "export default 1;");
      assert.equal(fetchCalls, 0);
    `;
    const child = runAuthChild(program);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  });

  it("preserves caller headers on same-origin redirects and filters credentials across origins", () => {
    const program = `
      import assert from "node:assert/strict";
      import { fetchModule } from ${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)};
      const calls = [];
      globalThis.fetch = async (url, options) => {
        const href = String(url);
        const headers = new Headers(options.headers);
        calls.push({ url: href, headers });
        if (href === "https://same.example.test/start.mjs") {
          return new Response(null, { status: 302, headers: { location: "/finish.mjs" } });
        }
        if (href === "https://source.example.test/start.mjs") {
          return new Response(null, { status: 302, headers: { location: "https://target.example.test/finish.mjs" } });
        }
        return new Response("export default 1;", { headers: { "content-type": "application/javascript" } });
      };

      const sameOriginHeaders = {
        Authorization: "Basic caller",
        "Proxy-Authorization": "Basic proxy",
        Cookie: "session=same-origin",
        Cookie2: "legacy=same-origin",
        "X-Request": "same-origin",
      };
      await fetchModule("https://same.example.test/start.mjs", { headers: sameOriginHeaders });
      assert.equal(calls[0].headers.get("authorization"), "Basic caller");
      assert.equal(calls[1].headers.get("authorization"), "Basic caller");
      assert.equal(calls[1].headers.get("proxy-authorization"), "Basic proxy");
      assert.equal(calls[1].headers.get("cookie"), "session=same-origin");
      assert.equal(calls[1].headers.get("cookie2"), "legacy=same-origin");
      assert.equal(calls[1].headers.get("x-request"), "same-origin");
      assert.deepEqual(sameOriginHeaders, {
        Authorization: "Basic caller",
        "Proxy-Authorization": "Basic proxy",
        Cookie: "session=same-origin",
        Cookie2: "legacy=same-origin",
        "X-Request": "same-origin",
      });

      await fetchModule("https://source.example.test/start.mjs", {
        headers: {
          Authorization: "Basic caller-cross-origin",
          "Proxy-Authorization": "Basic proxy",
          Cookie: "session=cross-origin",
          Cookie2: "legacy=cross-origin",
          "X-Request": "cross-origin",
        },
      });
      assert.equal(calls[2].headers.get("authorization"), "Basic caller-cross-origin");
      assert.equal(calls[2].headers.get("proxy-authorization"), "Basic proxy");
      assert.equal(calls[2].headers.get("cookie"), "session=cross-origin");
      assert.equal(calls[2].headers.get("cookie2"), "legacy=cross-origin");
      assert.equal(calls[3].headers.get("authorization"), "Bearer target-token");
      assert.equal(calls[3].headers.get("proxy-authorization"), null);
      assert.equal(calls[3].headers.get("cookie"), null);
      assert.equal(calls[3].headers.get("cookie2"), null);
      assert.equal(calls[3].headers.get("x-request"), "cross-origin");

      const { writeFileSync } = await import("node:fs");
      const start = "https://locked-a.example.test/start.mjs";
      const middle = "https://locked-b.example.test/middle.mjs";
      const final = "https://locked-a.example.test/final.mjs";
      const { default: process } = await import("node:process");
      writeFileSync(process.env.URL_IMPORT_LOCK, JSON.stringify({
        version: "5",
        redirects: { [start]: middle, [middle]: final },
        remote: {},
      }));
      const { fetchModule: fetchLockedModule } = await import(${JSON.stringify(new URL("./fetch.ts", import.meta.url).href)});
      await fetchLockedModule(start, { headers: {
        Authorization: "Basic locked-caller",
        "Proxy-Authorization": "Basic locked-proxy",
        Cookie: "session=locked",
        Cookie2: "legacy=locked",
        "X-Request": "locked-chain",
      } });
      assert.equal(calls[4].url, final);
      assert.equal(calls[4].headers.get("authorization"), "Bearer locked-a-token");
      assert.equal(calls[4].headers.get("proxy-authorization"), null);
      assert.equal(calls[4].headers.get("cookie"), null);
      assert.equal(calls[4].headers.get("cookie2"), null);
      assert.equal(calls[4].headers.get("x-request"), "locked-chain");
    `;
    const child = runAuthChild(program,
      "source-token@source.example.test;target-token@target.example.test;locked-a-token@locked-a.example.test",
      true, true);
    assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  });

  it("rejects unsuccessful responses without preventing later downloads", async () => {
    await assert.rejects(fetchModule(`${baseUrl}/missing.mjs`));
    const result = await fetchModule(`${baseUrl}/available.mjs`);
    assert.equal(result.source, 'export default "/available.mjs";');
  });

  it("caches query variants independently", async () => {
    const firstUrl = `${baseUrl}/module.mjs?target=node`;
    const secondUrl = `${baseUrl}/module.mjs?target=es2022`;
    const first = await fetchModule(firstUrl);
    const second = await fetchModule(secondUrl);
    assert.notEqual(first.source, second.source);
    assert.equal(first.finalUrl, firstUrl);
    assert.equal(second.finalUrl, secondUrl);
    assert.deepEqual(requests, ["/module.mjs?target=node", "/module.mjs?target=es2022"]);
    assert.equal((await fetchModule(firstUrl)).source, first.source);
    assert.equal((await fetchModule(secondUrl)).source, second.source);
    assert.equal(requests.length, 2);
  });

  it("keeps fragment module identities while sharing their response bytes", async () => {
    const url = `${baseUrl}/fragments.mjs`;
    const first = await fetchModule(`${url}#first`);
    const second = await fetchModule(`${url}#second`);
    assert.equal(first.source, second.source);
    assert.equal(second.url, `${url}#second`);
    assert.equal(second.finalUrl, `${url}#second`);
    const modules = await Promise.all([import(`${url}#first`), import(`${url}#second`)]);
    assert.notEqual(modules[0], modules[1]);
    const raw = readFileSync(cachePaths(url).file);
    const marker = Buffer.from("\n// denoCacheMetadata=");
    const metadata = JSON.parse(raw.subarray(raw.lastIndexOf(marker) + marker.length).toString("utf8"));
    assert.equal(metadata.url, `${url}#first`);
    assert.equal(requests.length, 1);
  });

  it("caches and loads empty modules", async () => {
    const url = `${baseUrl}/empty.mjs`;
    assert.equal((await fetchModule(url)).source, "");
    assert.equal((await fetchModule(url)).source, "");
    assert.deepEqual(Object.keys(await import(url)), []);
    assert.equal(requests.length, 1);
  });

  it("preserves binary bytes through fetching, caching and module loading", async () => {
    const url = `${baseUrl}/binary.wasm`;
    const first = await fetchModule(url);
    assert.ok(first.source instanceof Uint8Array);
    assert.deepEqual(first.source, wasmBytes);
    const cached = await fetchModule(url);
    assert.ok(cached.source instanceof Uint8Array);
    assert.deepEqual([...cached.source], [...wasmBytes]);
    assert.equal((await import(url)).answer(), 42);
    assert.equal(requests.length, 1);
  });

  it("decodes response charsets while retaining raw bytes in the shared Deno cache", async () => {
    for (const encoded of encodedSources) {
      const url = `${baseUrl}${encoded.path}`;
      const downloaded = await fetchModule(url);
      const cached = await fetchModule(url);
      assert.equal(downloaded.source, encodedText);
      assert.deepEqual(cached, downloaded);
      assert.equal((await import(url)).default, "café");
      const raw = readFileSync(cachePaths(url).file);
      assert.deepEqual(raw.subarray(0, encoded.bytes.length), encoded.bytes);
      assert.equal(requests.filter((path) => path === encoded.path).length, 1);
    }
  });

  it("uses Deno's charset labels and strips only a decoded leading BOM", () => {
    const url = "https://encoding.test/mod.mjs";
    assert.equal(decodeModuleSource(Buffer.from([128]), url, "application/javascript; charset=iso-8859-1"), "€");
    assert.equal(decodeModuleSource(Buffer.from("\uFEFF\uFEFFtext"), url, "application/javascript"), "\uFEFFtext");
    assert.equal(decodeModuleSource(Buffer.from([72, 101, 255, 108, 111]), url, "application/javascript"), "He�lo");
    assert.throws(() => decodeModuleSource(Buffer.from("text"), url, "application/javascript; charset=utf-32le"));
  });

  it("preserves existing file permissions without bypassing umask for new files", { skip: process.platform === "win32" }, () => {
    const directory = mkdtempSync(join(tmpdir(), "node-url-import-mode-test-"));
    const path = join(directory, "deno.lock");
    const newPath = join(directory, "new.lock");
    const previousUmask = process.umask(0o022);
    try {
      writeFileSync(path, "old");
      chmodSync(path, 0o660);
      writeFileAtomicSync(path, "updated");
      assert.equal(statSync(path).mode & 0o777, 0o660);
      assert.equal(readFileSync(path, "utf8"), "updated");
      writeFileAtomicSync(newPath, "created");
      assert.equal(statSync(newPath).mode & 0o777, 0o644);
    } finally {
      process.umask(previousUmask);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows ten redirects but rejects an eleventh without caching the response", async () => {
    assert.equal((await fetchModule(`${baseUrl}/redirect/10`)).finalUrl, `${baseUrl}/redirect/0`);
    await assert.rejects(fetchModule(`${baseUrl}/redirect/11`));
    assert.equal(readCache(`${baseUrl}/redirect/11`), null);
  });

  it("drops request fragments on redirects without a fragment, like Deno", async () => {
    const first = await fetchModule(`${baseUrl}/fragment-redirect#first`);
    const second = await fetchModule(`${baseUrl}/fragment-redirect#second`);
    assert.equal(first.finalUrl, `${baseUrl}/fragment-target.mjs`);
    assert.equal(second.finalUrl, first.finalUrl);
    assert.deepEqual(first.redirectChain, [`${baseUrl}/fragment-redirect#first`, first.finalUrl]);
    assert.deepEqual(second.redirectChain, [`${baseUrl}/fragment-redirect#second`, second.finalUrl]);
    assert.deepEqual(requests, ["/fragment-redirect", "/fragment-target.mjs"]);
  });

  it("keeps explicit fragment replacements and removals when reading redirect stubs", async () => {
    for (const [path, expected] of [["/fragment-replaced", "/replaced-target.mjs#replacement"], ["/fragment-cleared", "/cleared-target.mjs#"]]) {
      const first = await fetchModule(`${baseUrl}${path}#original`);
      const second = await fetchModule(`${baseUrl}${path}#other`);
      assert.equal(first.finalUrl, `${baseUrl}${expected}`);
      assert.equal(second.finalUrl, first.finalUrl);
    }
    assert.equal(requests.length, 4);
  });

  it("times out stalled response bodies without caching partial source", async () => {
    const url = `${baseUrl}/cancelled.mjs`;
    await assert.rejects(fetchModule(url, { timeoutMs: 30 }));
    assert.equal(readCache(url), null);
    assert.equal((await fetchModule(`${baseUrl}/after-cancellation.mjs`)).source, 'export default "/after-cancellation.mjs";');
  });

  it("rejects redirects to non-HTTP module schemes", async () => {
    await assert.rejects(fetchModule(`${baseUrl}/invalid-redirect`));
    assert.equal(readCache(`${baseUrl}/invalid-redirect`), null);
  });

  it("exports the legacy loader as a resolvable package subpath", () => {
    assert.equal(import.meta.resolve("node-url-import/loader"), new URL("../dist/loader.js", import.meta.url).href);
  });

  it("uses Deno's unambiguous host and port cache directory names", () => {
    const paths = cachePaths("http://127.0.0.1:49653/module.mjs?v=1");
    assert.ok(paths.dir.endsWith("127.0.0.1_port_49653"));
    assert.ok(paths.file.endsWith("b22a08393817249b690133d8752be02b19e58c8ebe530a7b4d67a4d3eacaaa93"));
    assert.ok(cachePaths("http://api_8080/mod.mjs").dir.endsWith("api%5f8080"));
    assert.ok(cachePaths("http://api:8080/mod.mjs").dir.endsWith("api_port_8080"));
    assert.notEqual(cachePaths("http://api_port_8080/mod.mjs").dir, cachePaths("http://api:8080/mod.mjs").dir);
    assert.ok(cachePaths("http://[::1]:8080/mod.mjs").dir.endsWith("[::1]_port_8080"));
    const longHost = Array.from({ length: 3 }, () => "_".repeat(60)).join(".");
    const hashed = basename(cachePaths(`http://${longHost}/mod.mjs`).dir);
    assert.match(hashed, /^#[a-f0-9]{64}$/);
    assert.notEqual(hashed, basename(cachePaths(`http://${longHost}:8080/mod.mjs`).dir));
  });

  it("distinguishes an explicitly empty query in cache keys, like Deno", () => {
    assert.notEqual(cachePaths("https://query.test/mod.mjs").file, cachePaths("https://query.test/mod.mjs?").file);
    assert.equal(cachePaths("https://query.test/mod.mjs?").file, cachePaths("https://query.test/mod.mjs?#identity").file);
  });

  it("does not execute Deno's cached 404 or incomplete redirect stubs as empty modules", async () => {
    const url = `${baseUrl}/missing.mjs`;
    writeCache([url], "", "application/javascript");
    const path = cachePaths(url).file;
    for (const headers of [{ "x-deno-not-found": "404" }, { location: "" }]) {
      writeFileSync(path, "\n// denoCacheMetadata=" + JSON.stringify({ url, headers, time: Math.floor(Date.now() / 1000) }));
      assert.equal(readCache(url), null);
      await assert.rejects(fetchModule(url));
    }
  });

  it("rejects incomplete cache writes instead of executing partial source", () => {
    const url = `${baseUrl}/incomplete.mjs`;
    writeCache([url], "export default 1;", "application/javascript");
    const path = cachePaths(url).file;
    const complete = readFileSync(path);
    writeFileSync(path, complete.subarray(0, 10));
    assert.equal(readCache(url), null);
  });

  it("never exposes partially written entries to concurrent readers", async () => {
    const url = `${baseUrl}/concurrent.mjs`;
    const source = "export default 1;\n" + " ".repeat(2 * 1024 * 1024);
    writeCache([url], source, "application/javascript");
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const writer = new Worker(`
      const { workerData } = await import("node:worker_threads");
      const { writeCache } = await import(workerData.cacheUrl);
      try {
        for (let index = 0; index < 12; index++) {
          writeCache([workerData.url], workerData.source, "application/javascript");
        }
      } finally {
        Atomics.store(new Int32Array(workerData.signal), 0, 1);
      }
    `, {
      eval: true,
      execArgv: [],
      workerData: { cacheUrl: new URL("./cache.ts", import.meta.url).href, url, source, signal: signal.buffer },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (Atomics.load(signal, 0) === 0 && Date.now() < deadline) {
        const entry = readCache(url);
        assert.ok(entry && typeof entry.source === "string");
        assert.equal(Buffer.byteLength(entry.source), Buffer.byteLength(source));
        assert.equal(entry.source, source);
      }
      assert.equal(Atomics.load(signal, 0), 1);
    } finally {
      await writer.terminate();
    }
  });
});
