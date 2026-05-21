import { auth } from "@/core/auth/auth";
import { listUsersAction } from "@/features/users/actions";

import UsuariosClient from "./usuarios-client";

export default async function UsuariosPage() {
  const session = await auth();
  const currentUserId = session?.user?.id ?? "";

  const users = await listUsersAction(
    session?.user
      ? {
          id: session.user.id,
          email: session.user.email ?? "",
          role: session.user.role,
        }
      : null
  );

  return <UsuariosClient initialUsers={users} currentUserId={currentUserId} />;
}
