import { HuddleError } from "../errors.js";
import type { Transport } from "../transport/types.js";
import { sameLogin } from "./conversation.js";
import { selfAskAllowed } from "./paths.js";

/** Parses a GitHub noreply email: <id>+<login>@users.noreply.github.com or <login>@users.noreply.github.com. */
export function parseNoreplyEmail(email: string): string | null {
  const m = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com$/i.exec(email.trim());
  return m ? m[1] : null;
}

export async function resolveRecipient(
  t: Transport,
  who: string,
  me: string,
  authorNames?: (email: string) => string[],
): Promise<string> {
  const raw = who.trim().replace(/^@/, "");
  if (!raw) throw new HuddleError("--to must not be empty");
  let login: string | null = raw;
  if (raw.includes("@")) {
    login = parseNoreplyEmail(raw) ?? (await t.resolveLogin(raw));
    if (!login) {
      const names = authorNames?.(raw) ?? [];
      throw new HuddleError(
        names.length
          ? `Cannot resolve email ${raw} to a GitHub username. Author names for this email in git log: ${names.join(", ")}. Ask the user for the matching GitHub login and retry with --to <login>.`
          : `Cannot resolve email ${raw} to a GitHub username: in this repo's commits, this email is not linked to a GitHub account.` +
              ` Use a GitHub login instead (look up author names with git log --format='%an <%ae>', then ask the user for the matching login).`,
      );
    }
  }
  if (sameLogin(login, me) && !selfAskAllowed()) throw new HuddleError("You cannot ask yourself.");
  if (!(await t.hasWriteAccess(login))) {
    throw new HuddleError(`${login} does not exist or does not have write access to this repo, so they cannot be asked.`);
  }
  return login;
}
