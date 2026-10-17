import { createFileRoute } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { ListenRoom } from "@/components/space/listen-room";
import { LiveRoom } from "@/components/space/live-room";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { user, isPending } = useCurrentUserState();
  if (user) return <LiveRoom />;
  return <ListenRoom sessionPending={isPending} />;
}