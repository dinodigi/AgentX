import Link from "next/link";
import { Plus } from "lucide-react";
import { UserButton } from "@clerk/nextjs";
import { accessibleProjects } from "@/lib/access";

/** Projects home — only projects the viewer can open, plus creation. */
export default async function AdminHome() {
  const projects = await accessibleProjects();

  return (
    <div className="min-h-screen bg-white">
      <header className="flex items-center justify-between border-b border-[--color-line] px-6 py-3">
        <span className="text-sm font-medium">AgentX</span>
        <UserButton />
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8">
        <div className="mb-5 flex items-center">
          <h1 className="display text-xl font-semibold">Projects</h1>
          <Link
            href="/admin/new"
            className="btn btn-ink ml-auto"
          >
            <Plus className="h-4 w-4" />
            New project
          </Link>
        </div>

        {projects.length === 0 && (
          <div className="card p-8 text-center">
            <p className="font-medium">Start your first project</p>
            <p className="mt-1 text-sm text-[--color-ink-mute]">
              A project gets its own branded admin, MCP token, and delivery API.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const color = p.branding?.primaryColor ?? "#4f46e5";
            const name = p.branding?.displayName ?? p.name;
            return (
              <Link
                key={p.id}
                href={`/admin/${p.id}`}
                className="flex items-center gap-3 card p-4 hover:border-gray-300"
              >
                {p.branding?.logoUrl ? (
                  <img src={p.branding.logoUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
                ) : (
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-medium text-white"
                    style={{ background: color }}
                  >
                    {name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate font-medium">{name}</p>
                  <p className="truncate text-xs text-[--color-ink-mute]">{p.id}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
