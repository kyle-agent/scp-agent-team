export interface Config {
  port: number;
  apiToken: string;
  kagentBaseUrl: string;
  auditFile?: string;
  corsOrigins: string[];
  runTimeoutMs: number;
  agentsDir?: string;
  propagateUserIdentity: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export function loadConfig(): Config {
  const mock = process.env.MOCK_KAGENT === 'true';
  return {
    port: Number(process.env.PORT ?? 8090),
    apiToken: required('SCP_API_TOKEN'),
    kagentBaseUrl:
      process.env.KAGENT_BASE_URL ??
      (mock ? 'http://127.0.0.1:8099' : required('KAGENT_BASE_URL')),
    auditFile: process.env.AUDIT_FILE,
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS ?? 180_000),
    agentsDir: process.env.AGENTS_DIR,
    propagateUserIdentity: process.env.PROPAGATE_USER_IDENTITY === 'true',
  };
}
