import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-request signals: the request id, and the tenant once something establishes it. */
export interface RequestSignals {
  requestId: string;
  tenantId: string | null;
}

export const requestAls = new AsyncLocalStorage<RequestSignals>();
export const currentRequest = () => requestAls.getStore();
