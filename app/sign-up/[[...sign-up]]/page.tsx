"use client";

import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b0b0d] p-6">
      <SignUp
        appearance={{
          variables: {
            colorBackground: "#101013",
            colorPrimary: "#facc15",
            colorText: "#f1f1f5",
            colorTextSecondary: "#9a9aa3",
            colorInputBackground: "#1f1f24",
            colorInputText: "#f1f1f5",
            colorDanger: "#ef4444",
          },
        }}
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/terms"
      />
    </div>
  );
}
