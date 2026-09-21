import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../../../../lib/auth/session";
import { prisma } from "../../../../lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) {
    return NextResponse.json({ user: null });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { entity: true },
  });

  if (!user) {
    return NextResponse.json({ user: null });
  }

  return NextResponse.json({
    user: {
      userId: user.id,
      entityId: user.entityId,
      phone: user.phone,
      kycStatus: user.entity.kycStatus,
      legalName: user.entity.legalName,
    },
  });
}
