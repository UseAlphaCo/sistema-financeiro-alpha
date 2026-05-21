export const MANAGED_USER_ROLES = ["admin", "financeiro"] as const;
export const USER_STATUSES = ["active", "disabled"] as const;

export type ManagedUserRole = (typeof MANAGED_USER_ROLES)[number];
export type UserStatus = (typeof USER_STATUSES)[number];

export type UserRecord = {
  id: string;
  email: string;
  role: ManagedUserRole;
  status: UserStatus;
  forcePasswordChange: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreateUserInput = {
  email: string;
  role: ManagedUserRole;
};

export type UpdateUserInput = {
  id: string;
  role?: ManagedUserRole;
  status?: UserStatus;
};
