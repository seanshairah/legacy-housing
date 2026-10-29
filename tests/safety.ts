export function assertTestDatabase() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL_REQUIRED_FOR_TESTS");
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/legacy_test(?:_[a-z0-9]+)*$/.test(url.pathname)
  )
    throw new Error("Tests require a dedicated loopback legacy_test database");
  return url;
}
