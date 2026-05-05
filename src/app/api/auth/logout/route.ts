import { NextRequest, NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/core/auth/supabase-server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  const origin = new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/login`);
}
