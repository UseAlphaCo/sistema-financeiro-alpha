import { getPrismaClient } from "../src/core/db/prisma-client";
import { hash } from "bcryptjs";

async function main() {
  const prisma = getPrismaClient();
  const defaultPasswordHash = await hash("noob00", 12);

  const categories = [
    { name: "Aluguel", direction: "saida" },
    { name: "Energia", direction: "saida" },
    { name: "Fornecedores", direction: "saida" },
    { name: "Impostos", direction: "saida" },
    { name: "Internet", direction: "saida" },
    { name: "Marketing", direction: "saida" },
    { name: "Pró-labore", direction: "saida" },
    { name: "Salários", direction: "saida" },
    { name: "Serviços", direction: "entrada" },
    { name: "Software", direction: "saida" },
    { name: "Taxas bancárias", direction: "saida" },
    { name: "Transferências", direction: "entrada" },
    { name: "Transporte", direction: "saida" },
    { name: "Vendas", direction: "entrada" },
  ];

  for (const cat of categories) {
    await prisma.transactionCategory.upsert({
      where: { name: cat.name },
      update: {},
      create: { ...cat },
    });
  }

  const admins = [
    "sendylago@usealphaco.com.br",
    "matheus@usealphaco.com.br",
  ];

  for (const email of admins) {
    await prisma.user.upsert({
      where: { email },
      update: {
        role: "admin",
        status: "active",
        forcePasswordChange: false,
      },
      create: {
        email,
        passwordHash: defaultPasswordHash,
        role: "admin",
        status: "active",
        forcePasswordChange: false,
      },
    });
  }

  console.log("Categorias e admins iniciais cadastrados.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
