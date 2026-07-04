import Link from "next/link";
import { NewProjectForm } from "./NewProjectForm";

export default function NewProjectPage() {
  return (
    <div className="min-h-screen bg-white">
      <main className="mx-auto max-w-lg px-6 py-10">
        <p className="mb-2 text-sm text-gray-400">
          <Link href="/admin" className="hover:text-gray-600">
            ← Projects
          </Link>
        </p>
        <h1 className="mb-5 text-lg font-medium">New project</h1>
        <NewProjectForm />
      </main>
    </div>
  );
}
