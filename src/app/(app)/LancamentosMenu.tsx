"use client";

import { useRef, useState } from "react";

export function LancamentosMenu() {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleMouseEnter() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }

  function handleMouseLeave() {
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  }

  return (
    <div
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <a href="/lancamentos" className="hover:text-gray-900">
        Lançamentos
      </a>
      {open && (
        <div className="absolute left-0 top-full pt-1 z-20">
          <div className="rounded border border-gray-200 bg-white shadow-md min-w-[160px] py-1">
            <a
              href="/lancamentos/categorias"
              className="block px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900"
            >
              Categorias
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
