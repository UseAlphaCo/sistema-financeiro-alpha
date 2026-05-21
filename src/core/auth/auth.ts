import NextAuth from "next-auth";

import { authConfig } from "@/core/auth/auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
