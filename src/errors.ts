export class ClientError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function redact(value: string): string {
  return value.replace(/pgai_[A-Za-z0-9_-]+/g, '[redacted]');
}
export function message(error: unknown): string {
  return redact(error instanceof ClientError ? error.message : 'PaveGrid request failed. Check your connection and try again.');
}
export function validateToken(value: string): string {
  const token = value.trim();
  if (!/^pgai_[A-Za-z0-9_-]{1,1024}$/.test(token)) throw new ClientError('invalid_token', 'Enter an AI access token that starts with pgai_.');
  return token;
}
