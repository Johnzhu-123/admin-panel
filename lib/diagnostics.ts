export type FailureLogEntry = {
  id: string;
  at: string;
  provider: string;
  operation: string;
  url: string;
  status: number | null;
  requestBody: string;
  responseBody: string;
};

const MAX_LOGS = 200;
const BODY_LIMIT = 4000;
const failureLogs: FailureLogEntry[] = [];

const truncate = (value: string, limit = BODY_LIMIT) => {
  if (!value) return "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n...[truncated]`;
};

const formatBody = (body: unknown) => {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return truncate(body);
  try {
    return truncate(JSON.stringify(body, null, 2));
  } catch {
    return truncate(String(body));
  }
};

export const recordFailureLog = (entry: {
  provider: string;
  operation: string;
  url: string;
  status: number | null;
  requestBody?: unknown;
  responseBody?: unknown;
}) => {
  const log: FailureLogEntry = {
    id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    provider: entry.provider,
    operation: entry.operation,
    url: entry.url,
    status: entry.status ?? null,
    requestBody: formatBody(entry.requestBody),
    responseBody: formatBody(entry.responseBody),
  };
  failureLogs.unshift(log);
  if (failureLogs.length > MAX_LOGS) {
    failureLogs.length = MAX_LOGS;
  }
};

export const listFailureLogs = () => [...failureLogs];

export const clearFailureLogs = () => {
  failureLogs.length = 0;
};
