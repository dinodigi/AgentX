import { SignIn } from "@clerk/nextjs";

export default function Page() {
  return (
    <div className="flex min-h-screen items-start justify-center pt-24">
      {/* Without a fallback, Clerk's default post-auth destination is "/" — the
          marketing page (found live). A middleware-provided redirect_url (the
          /admin deep-link case) still takes precedence over this fallback. */}
      <SignIn fallbackRedirectUrl="/admin" />
    </div>
  );
}
