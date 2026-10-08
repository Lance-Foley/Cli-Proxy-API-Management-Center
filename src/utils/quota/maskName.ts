/**
 * Mask the email embedded in a credential filename for screen sharing.
 *
 * Auth filenames look like `claude-someone@example.dev.json` or
 * `codex-<id>-someone@example.com-pro.json`. The provider prefix and plan suffix are
 * kept; the email keeps one character of the local part and the domain's last label.
 */

const MASK = '•••';
const EMAIL_IN_NAME = /([^@\s]+)@([A-Za-z0-9.]+)/;

export function maskCredentialName(name: string): string {
  const match = EMAIL_IN_NAME.exec(name);
  if (!match) return name;

  const [whole, before, domainRaw] = match;
  const hasJsonTail = domainRaw.endsWith('.json');
  const domain = hasJsonTail ? domainRaw.slice(0, -'.json'.length) : domainRaw;
  if (!before || !domain) return name;

  // Everything up to the last hyphen is provider/id prefix, not the mailbox.
  const split = before.lastIndexOf('-') + 1;
  const prefix = before.slice(0, split);
  const local = before.slice(split);

  const lastDot = domain.lastIndexOf('.');
  const domainHead = lastDot === -1 ? domain : domain.slice(0, lastDot);
  const domainTail = lastDot === -1 ? '' : domain.slice(lastDot);

  const maskedLocal = `${local.charAt(0)}${MASK}`;
  const maskedDomain = `${domainHead.charAt(0)}${MASK}${domainTail}`;
  const masked = `${prefix}${maskedLocal}@${maskedDomain}${hasJsonTail ? '.json' : ''}`;
  return name.replace(whole, masked);
}
