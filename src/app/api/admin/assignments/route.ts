import { NextResponse } from "next/server";
import { z } from "zod";
import { STUDY_IDS } from "@/lib/studies";
import { ManualAssignmentError, setManualAssignments } from "@/server/admin";
import { apiError, HttpError, requireApiUser } from "@/server/http";

const body = z.object({
  userId: z.string(),
  study: z.enum(STUDY_IDS),
  questionNumbers: z.array(z.number().int().min(1).max(10_000)).max(10_000),
});

export async function POST(req: Request) {
  try {
    const { db } = await requireApiUser(req, "admin");
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, "Invalid assignment request");
    try {
      return NextResponse.json(await setManualAssignments(db, parsed.data.userId, parsed.data.study, parsed.data.questionNumbers));
    } catch (error) {
      if (error instanceof ManualAssignmentError) throw new HttpError(400, error.message);
      throw error;
    }
  } catch (error) {
    return apiError(error);
  }
}
