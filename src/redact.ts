/**
 * Data minimisation: an agent answering "where is order #1234?" doesn't need
 * the customer's phone number. Emails keep their domain, phones their last two
 * digits, street lines are dropped; city, postcode and country stay because
 * they're needed for shipping questions.
 */

const EMAIL_KEYS = new Set(["email", "billing_email", "customer_email"]);
const PHONE_KEYS = new Set(["phone", "billing_phone"]);
const DROP_KEYS = new Set(["address_1", "address_2", "customer_ip_address", "customer_user_agent", "transaction_id", "payment_url"]);
const NAME_KEYS = new Set(["first_name", "last_name", "company"]);

export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain || !user) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 2 ? `***${digits.slice(-2)}` : "***";
}

export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_KEYS.has(k)) continue;
      if (EMAIL_KEYS.has(k) && typeof v === "string") out[k] = maskEmail(v);
      else if (PHONE_KEYS.has(k) && typeof v === "string") out[k] = maskPhone(v);
      else if (NAME_KEYS.has(k) && typeof v === "string") out[k] = v ? `${v.slice(0, 1)}.` : v;
      else out[k] = redact(v);
    }
    return out as T;
  }
  return value;
}
