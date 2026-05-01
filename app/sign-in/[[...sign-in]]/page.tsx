import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0b0b0d",
        padding: "24px",
      }}
    >
      <SignIn
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
        path="/sign-in"
        signUpUrl="/sign-up"
      />
    </div>
  );
}
