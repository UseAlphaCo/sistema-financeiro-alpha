import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/types/api";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: UserRole;
      forcePasswordChange: boolean;
    } & DefaultSession["user"];
  }

  interface User {
    role: UserRole;
    forcePasswordChange: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    forcePasswordChange?: boolean;
  }
}
