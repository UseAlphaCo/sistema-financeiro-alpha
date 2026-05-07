export type CategoryDirection = 'entrada' | 'saida';

export type TransactionCategory = {
  id: string;
  name: string;
  direction: CategoryDirection;
  color?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateCategoryInput = {
  name: string;
  direction: CategoryDirection;
  color?: string;
};

export type UpdateCategoryInput = {
  id: string;
  name?: string;
  direction?: CategoryDirection;
  color?: string;
};
