export type Severity = "ok" | "warn" | "fail";

export type ServerTransport =
  | { kind: "stdio"; command: string; args: string[] }
  | { kind: "http"; url: string }
  | { kind: "unknown" };

export type ParsedServer = {
  name: string;
  transport: ServerTransport;
  raw: Record<string, unknown>;
};

export type ConfigFile = {
  path: string;
  format: "mcpServers" | "servers" | "unknown";
  servers: ParsedServer[];
};

export type Finding = {
  severity: Severity;
  code: string;
  message: string;
  server?: string;
  file?: string;
};

export type ServerReport = {
  name: string;
  file: string;
  transport: ServerTransport["kind"];
  status: Severity;
  findings: Finding[];
};

export type HealthReport = {
  scannedAt: string;
  root: string;
  files: string[];
  servers: ServerReport[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
    files: number;
    servers: number;
  };
};
