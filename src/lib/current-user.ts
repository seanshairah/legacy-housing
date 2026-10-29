import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { session } from "../domain/identity";
export async function currentUser() {
  return session((await cookies()).get("legacy_session")?.value);
}
export async function requireUser() {
  const u = await currentUser();
  if (!u) redirect("/auth");
  return u;
}
