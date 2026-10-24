export interface RuntimeTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  onEvent(listener: (method: string, params: unknown) => void): () => void;
  onReconnect?(listener: () => void): () => void;
}

export interface ClosableRuntimeTransport extends RuntimeTransport {
  close(): Promise<void>;
}
