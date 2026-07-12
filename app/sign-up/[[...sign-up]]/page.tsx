import { SignUp } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-start justify-center pt-24">
      {/* New sign-ups land in the studio (their workspace + free sandbox),
          not back on the marketing page. redirect_url still wins if present. */}
      <SignUp fallbackRedirectUrl="/admin" />
    </div>
  );
}
