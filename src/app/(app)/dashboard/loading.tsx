function SkeletonCard({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg border border-gray-200 bg-gray-100 ${className}`} />;
}

export default function DashboardLoading() {
  return (
    <div className="w-full space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="h-6 w-48 animate-pulse rounded bg-gray-200" />
          <div className="h-3 w-32 animate-pulse rounded bg-gray-100" />
        </div>
        <div className="flex gap-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-16 animate-pulse rounded-md bg-gray-100" />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} className="h-20" />
        ))}
      </div>

      <SkeletonCard className="h-40" />
      <SkeletonCard className="h-40" />
    </div>
  );
}
