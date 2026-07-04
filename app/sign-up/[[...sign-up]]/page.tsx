import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-start justify-center pt-24">
      <SignUp />
    </div>
  );
}
