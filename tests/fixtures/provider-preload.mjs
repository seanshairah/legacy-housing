const { URL, Request, Headers } = globalThis;
// Test-only network boundary. The production app never imports this module.
const url = new URL(process.env.DATABASE_URL || "http://invalid");
if (
  process.env.LEGACY_PROVIDER_FIXTURE !== "true" ||
  !["localhost", "127.0.0.1"].includes(url.hostname) ||
  !/^\/legacy_test(?:_[a-z0-9]+)*$/.test(url.pathname)
)
  throw Error("PROVIDER_FIXTURE_REQUIRES_LOCAL_TEST_DATABASE");
const actualFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (
    ["www.paynow.co.zw", "api.resend.com", "smspop.co.zw"].includes(
      target.hostname,
    )
  ) {
    if (target.protocol !== "https:") throw Error("INSECURE_PROVIDER_REQUEST");
    const headers = Object.fromEntries(new Headers(init?.headers));
    return actualFetch("http://127.0.0.1:3410/transport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: target.href,
        headers,
        body:
          typeof init?.body === "string" ? init.body : String(init?.body || ""),
      }),
    });
  }
  if (
    target.hostname.endsWith(".paynow.co.zw") ||
    target.hostname.endsWith(".resend.com") ||
    target.hostname.endsWith(".smspop.co.zw")
  )
    throw Error("UNEXPECTED_PROVIDER_HOST");
  return actualFetch(input, init);
};
