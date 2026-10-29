import { NextResponse } from "next/server";
import { currentUser } from "../../../lib/current-user";
import { rateLimit } from "../../../domain/identity";
import {
  getOrganisation,
  listOrganisations,
  organisationProperties,
} from "../../../domain/organisations";

export async function GET(request: Request) {
  const actor = await currentUser();
  if (!actor)
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const query = new URL(request.url).searchParams;
  const organisationId = query.get("organisationId"),
    cursor = query.get("cursor") || undefined;
  const headers = { "Cache-Control": "private, no-store" };
  try {
    await rateLimit(`organisation-api:${actor.id}`, 200);
    if (!organisationId)
      return NextResponse.json(await listOrganisations(actor, cursor), {
        headers,
      });
    if (query.get("resource") === "properties")
      return NextResponse.json(
        await organisationProperties(actor, organisationId, cursor),
        { headers },
      );
    return NextResponse.json(
      { data: await getOrganisation(actor, organisationId) },
      { headers },
    );
  } catch {
    return NextResponse.json(
      { error: "ORGANISATION_ACCESS_DENIED" },
      { status: 403, headers },
    );
  }
}
