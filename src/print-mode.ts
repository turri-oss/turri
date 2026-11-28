import { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Turri } from "@turri-dev/core";

/**
 * pi's print, json and rpc modes make their session themselves, with turri's extension built in, and hand it to no
 * extension: it is adopted here as pi binds it to its extensions - the session's one chat, which keeps it as rpc replaces
 * it (a new session, a fork) - so the chat has its title, its entries and its cost in `spending()`. The core binds no
 * session of a session with no front end itself, so this sees pi's alone. Returns what puts pi's method back.
 */
export function adoptAsBound(turri: Turri, prototype: Pick<AgentSession, "bindExtensions"> = AgentSession.prototype): () => void {
  const bind = prototype.bindExtensions;
  prototype.bindExtensions = async function (this: AgentSession, ...args: Parameters<AgentSession["bindExtensions"]>) {
    const chat = turri.chats.adopt(this);
    // The chat the person looks at: pi's next session, rebuilt, is built for it and adopted into it.
    if (turri.chats.focused() !== chat.id) await turri.chats.focus(chat.id);
    return bind.apply(this, args);
  };
  return () => {
    prototype.bindExtensions = bind;
  };
}
