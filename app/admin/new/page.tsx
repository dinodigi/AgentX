import Link from "next/link";
import { NewProjectForm } from "./NewProjectForm";

export default function NewProjectPage() {
  return (
    <div className="min-h-screen bg-white">
      <main className="mx-auto max-w-lg px-6 py-10">
        <p className="mb-2 text-sm text-[--color-ink-mute]">
          <Link href="/admin" className="hover:text-[--color-ink-soft]">
            ← Projects
          </Link>
        </p>
        <h1 className="display mb-5 text-xl font-semibold">New project</h1>
        <NewProjectForm />
      </main>
    </div>
  );
}
