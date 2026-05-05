import { webhookEventsRepository } from "@/features/integration/webhook-events-repository";
import type { WebhookEvent } from "@/features/integration/types";

export const dynamic = "force-dynamic";
const STATUS_LABELS: Record<WebhookEvent["status"], string> = {
  processed: "Processado",
  failed: "Falhou",
  skipped: "Ignorado",
};

const STATUS_CLASSES: Record<WebhookEvent["status"], string> = {
  processed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  skipped: "bg-gray-100 text-gray-600",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

export default async function IntegracoesPage() {
  const { items, pagination } = await webhookEventsRepository.list({
    page: 1,
    limit: 50,
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Integrações</h1>
        <p className="mt-1 text-sm text-gray-500">
          Últimos eventos recebidos via webhook
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500">
          Nenhum evento registrado ainda.
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Origem</th>
                  <th className="px-4 py-3 text-left">Tópico</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Processado em</th>
                  <th className="px-4 py-3 text-left">Criado em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((event) => (
                  <tr key={event.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900 capitalize">
                      {event.source}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-gray-600">
                      {event.topic}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[event.status]}`}
                      >
                        {STATUS_LABELS[event.status]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                      {formatDate(event.processedAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-500">
                      {formatDate(event.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-gray-400">
            Exibindo {items.length} de {pagination.total} eventos
          </p>
        </>
      )}
    </div>
  );
}
