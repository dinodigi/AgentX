import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { getViewer } from "@/lib/access";
import { NewProjectForm } from "./NewProjectForm";

export default async function NewProjectPage() {
  const viewer = await getViewer();
  const canCreate = viewer?.isPlatformOperator ?? false;
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-8 py-4">
          <Link href="/admin" className="display text-[15px] font-semibold tracking-tight">
            Agent<span className="text-ink-mute">X</span>
          </Link>
          <UserButton />
        </div>
      </header>

      {!canCreate ? (
        <main className="page-enter mx-auto max-w-lg px-8 py-10">
          <p className="eyebrow mb-1.5">Private beta</p>
          <h1 className="display mb-2 text-[26px] font-semibold leading-none">
            Project creation is invite-only
          </h1>
          <p className="mb-6 text-sm leading-relaxed text-ink-mute">
            During the beta we onboard projects by hand. Projects shared with
            you appear on your dashboard. Want one of your own? Request a beta
            spot and we&apos;ll set it up with you.
          </p>
          <div className="flex items-center gap-4">
            <Link href="/pricing" className="btn rounded-md px-4 py-2 text-sm font-medium">
              Request beta access
            </Link>
            <Link href="/admin" className="text-sm text-ink-mute transition-colors hover:text-ink">
              ← Back to projects
            </Link>
          </div>
        </main>
      ) : (
      <main className="page-enter mx-auto max-w-lg px-8 py-10">
        <p className="mb-3 text-sm text-ink-mute">
          <Link href="/admin" className="transition-colors hover:text-ink-soft">
            ← Projects
          </Link>
        </p>
        <p className="eyebrow mb-1.5">Studio</p>
        <h1 className="display mb-1 text-[26px] font-semibold leading-none">New project</h1>
        <p className="mb-6 text-sm text-ink-mute">
          A branded admin, MCP token, and delivery API — ready for an agent to
          define the data model.
        </p>
        <NewProjectForm />
      </main>
      )}
    </div>
  );
}
