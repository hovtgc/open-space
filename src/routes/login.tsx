import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { ListenRoom } from "@/components/space/listen-room";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user, isPending } = useCurrentUserState();
  if (user) return <Navigate to="/" />;
  return <ListenRoom sessionPending={isPending} />;
}