import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { NewProjectForm } from "./NewProjectForm";

export default function NewProjectPage() {
  return (
    <div className="min-h-screen">
      <header className="bg-[#16130e]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-8 py-4">
          <Link href="/admin" className="display text-[15px] font-semibold tracking-tight text-white">
            Agent<span className="text-white/50">X</span>
          </Link>
          <UserButton />
        </div>
      </header>

      <main className="page-enter mx-auto max-w-lg px-8 py-10">
        <p className="mb-3 text-sm text-[--color-ink-mute]">
          <Link href="/admin" className="transition-colors hover:text-[--color-ink-soft]">
            ← Projects
          </Link>
        </p>
        <p className="eyebrow mb-1.5">Studio</p>
        <h1 className="display mb-1 text-[26px] font-semibold leading-none">New project</h1>
        <p className="mb-6 text-sm text-[--color-ink-mute]">
          A branded admin, MCP token, and delivery API — ready for an agent to
          define the data model.
        </p>
        <NewProjectForm />
      </main>
    </div>
  );
}
