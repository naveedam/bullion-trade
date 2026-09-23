import { NextRequest, NextResponse } from "next/server";
import { prisma } from "../../../../lib/db";

/**
 * POST /api/admin/verify-entity
 * body: { phone: "+9198XXXXXXXX" } OR { entityId: "..." }
 *
 * There is no KYC review workflow (document upload, manual approval queue,
 * etc.) built yet - that's real, separate work. This is the minimal lever
 * to unblock testing the order-confirmation flow without it: flips an
 * entity straight to VERIFIED. Protected the same way as the other
 * /api/admin/* routes (X-Admin-Secret header matching ADMIN_SECRET) -
 * this is meant to be reachable by you, not a real admin panel.
 */
export async function POST(req: NextRequest) {
  const adminSecret = req.headers.get("x-admin-secret");
  if (adminSecret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const phone = typeof body.phone === "string" ? body.phone.trim() : undefined;
  const entityId = typeof body.entityId === "string" ? body.entityId.trim() : undefined;

  if (!phone && !entityId) {
    return NextResponse.json({ error: "phone or entityId is required" }, { status: 400 });
  }

  try {
    let targetEntityId = entityId;
    if (!targetEntityId && phone) {
      const user = await prisma.user.findUnique({ where: { phone } });
      if (!user) {
        return NextResponse.json({ error: `No user found for phone ${phone}` }, { status: 404 });
      }
      targetEntityId = user.entityId;
    }

    // Belt-and-suspenders: by construction this is always a string here
    // (the earlier phone-or-entityId check guarantees one path sets it),
    // but that guarantee spans two different variables and isn't
    // something TypeScript's control-flow narrowing can see through — a
    // real generated Prisma client requires `where.id` to be a definite
    // string, not string | undefined, so this check is load-bearing for
    // both type-safety and runtime correctness, not just documentation.
    if (!targetEntityId) {
      return NextResponse.json({ error: "Could not resolve an entity to verify" }, { status: 500 });
    }

    const entity = await prisma.entity.update({
      where: { id: targetEntityId },
      data: { kycStatus: "VERIFIED", kycVerifiedAt: new Date() },
    });

    return NextResponse.json({
      entityId: entity.id,
      legalName: entity.legalName,
      kycStatus: entity.kycStatus,
      kycVerifiedAt: entity.kycVerifiedAt,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[admin:verify-entity] error", err);
    return NextResponse.json({ error: "Could not verify entity" }, { status: 500 });
  }
}
