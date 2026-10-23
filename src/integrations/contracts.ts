import type { Actor } from "../domain/access";
export type ConnectionStatus =
  | "READY_FOR_CREDENTIALS"
  | "LOCAL_VALIDATED"
  | "SANDBOX_VALIDATED"
  | "PRODUCTION_VERIFIED";
export interface ConnectorHealth {
  status: ConnectionStatus;
  detail: string;
  checkedAt: string;
}
export interface PaymentProvider {
  initiate(actor: Actor, paymentId: string): Promise<string>;
  reconcile(paymentId: string): Promise<unknown>;
}
export interface ExchangeConnector {
  provider: string;
  testConnection(actor: Actor, propertyId: string): Promise<ConnectorHealth>;
  export(
    actor: Actor,
    propertyId: string,
  ): Promise<{ headers: string[]; rows: string[][] }>;
}
export interface ObjectStorageProvider {
  put(key: string, encryptedBytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export interface AntivirusScanner {
  scan(bytes: Buffer): Promise<"CLEAN" | "INFECTED">;
}
export interface SignatureProvider {
  mode: "MANUAL_REVIEW" | "EXTERNAL";
  issue(
    actor: Actor,
    applicationId: string,
    templateId: string,
  ): Promise<unknown>;
}
